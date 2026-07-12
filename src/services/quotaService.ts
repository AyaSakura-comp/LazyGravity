import { logger } from '../utils/logger';
import { exec } from 'child_process';
import { promisify } from 'util';
import { readFile } from 'fs/promises';
import * as https from 'https';

const execAsync = promisify(exec);

export interface QuotaInfo {
    remainingFraction: number;
    resetTime: string;
}

export interface ModelQuota {
    label: string;
    model: string;
    quotaInfo?: QuotaInfo;
}

export interface UserStatusData {
    clientModelConfigs?: ModelQuota[];
}

export class QuotaService {
    private cachedPort: number | null = null;
    private cachedCsrfToken: string | null = null;
    private cachedPid: number | null = null;

    /**
     * Read a process's full command line.
     * Linux: /proc/<pid>/cmdline (NUL-separated). macOS/other: fall back to `ps`.
     */
    private async getCmdline(pid: number): Promise<string | null> {
        try {
            const buf = await readFile(`/proc/${pid}/cmdline`);
            if (buf && buf.length > 0) {
                return buf.toString('utf8').replace(/\0/g, ' ').trim();
            }
        } catch {
            // Not Linux (or process gone) — fall through to ps.
        }
        try {
            const { stdout } = await execAsync(`ps -p ${pid} -o command=`);
            return stdout.trim() || null;
        } catch {
            return null;
        }
    }

    /**
     * Discover every Antigravity language_server process and its --csrf_token.
     *
     * NOTE: `pgrep -fl` only prints the (truncated) process name on Linux, so the
     * previous implementation never saw the args and always failed here. We now
     * resolve each PID's full cmdline via /proc (Linux) or `ps` (macOS). Antigravity
     * spawns one language_server per workspace, so we return all candidates and let
     * fetchQuota() probe each until GetUserStatus returns model configs.
     */
    private async getProcessInfos(): Promise<Array<{ pid: number; csrf_token: string }>> {
        const results: Array<{ pid: number; csrf_token: string }> = [];
        try {
            const { stdout } = await execAsync('pgrep -f language_server');
            const pids = stdout
                .split('\n')
                .map((s) => parseInt(s.trim(), 10))
                .filter((n) => Number.isInteger(n) && n > 0);
            for (const pid of pids) {
                const cmd = await this.getCmdline(pid);
                if (!cmd) continue;
                // Match --csrf_token but not --extension_server_csrf_token (needs literal `--` prefix).
                const tokenMatch = cmd.match(/(?:^|\s)--csrf_token[=\s]+([a-zA-Z0-9\-]+)/);
                if (tokenMatch && tokenMatch[1]) {
                    results.push({ pid, csrf_token: tokenMatch[1] });
                }
            }
        } catch (e) {
            logger.error('Failed to get process info:', e);
        }
        return results;
    }

    private async getListeningPorts(pid: number): Promise<number[]> {
        const ports: number[] = [];
        try {
            // macOS
            const { stdout } = await execAsync(`lsof -nP -a -iTCP -sTCP:LISTEN -p ${pid}`);
            const regex = new RegExp(`^\\S+\\s+${pid}\\s+.*?(?:TCP|UDP)\\s+(?:\\*|[\\d.]+|\\[[\\da-f:]+\\]):(\\d+)\\s+\\(LISTEN\\)`, 'gim');
            let match;
            while ((match = regex.exec(stdout)) !== null) {
                const port = parseInt(match[1], 10);
                if (!ports.includes(port)) {
                    ports.push(port);
                }
            }
        } catch (e) {
            logger.error(`Failed to get ports for pid ${pid}:`, e);
        }
        return ports;
    }

    private requestApi(port: number, csrfToken: string): Promise<UserStatusData> {
        return new Promise((resolve, reject) => {
            const data = JSON.stringify({
                metadata: { ideName: 'antigravity', extensionName: 'antigravity', locale: 'en' }
            });
            const options: https.RequestOptions = {
                hostname: '127.0.0.1',
                port: port,
                path: '/exa.language_server_pb.LanguageServerService/GetUserStatus',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(data),
                    'Connect-Protocol-Version': '1',
                    'X-Codeium-Csrf-Token': csrfToken,
                },
                rejectUnauthorized: false,
                timeout: 2000,
            };

            const req = https.request(options, res => {
                let body = '';
                res.on('data', chunk => body += chunk);
                res.on('end', () => {
                    if (res.statusCode !== 200) {
                        return reject(new Error(`HTTP ${res.statusCode}`));
                    }
                    try {
                        const parsed = JSON.parse(body);
                        const cascadeData = parsed?.userStatus?.cascadeModelConfigData;
                        const rawConfigs: any[] = cascadeData?.clientModelConfigs || [];
                        const configs: ModelQuota[] = rawConfigs.map((c: any) => {
                            const label = c.label || c.displayName || c.modelName || c.model || '';
                            const model = c.model || c.modelId || '';
                            const qi = c.quotaInfo || c.quota || c.usageInfo;
                            const quotaInfo = qi ? {
                                remainingFraction: qi.remainingFraction ?? qi.remaining ?? 1,
                                resetTime: qi.resetTime || qi.resetAt || '',
                            } : undefined;
                            return { label, model, quotaInfo };
                        });
                        resolve({ clientModelConfigs: configs });
                    } catch (e) {
                        reject(new Error('Invalid JSON response'));
                    }
                });
            });

            req.on('error', reject);
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });

            req.write(data);
            req.end();
        });
    }

    public async fetchQuota(): Promise<ModelQuota[]> {
        // Fast path: a previously working (pid, csrf, port) combination.
        if (this.cachedPid && this.cachedCsrfToken && this.cachedPort) {
            try {
                const data = await this.requestApi(this.cachedPort, this.cachedCsrfToken);
                const configs = data.clientModelConfigs || [];
                if (configs.length > 0) return configs;
            } catch {
                // Fall through to a full rescan.
            }
            this.cachedPort = null;
        }

        const processes = await this.getProcessInfos();
        if (processes.length === 0) {
            logger.error('No language_server process found.');
            return [];
        }

        // GetUserStatus is account-global but only some language_servers answer it,
        // so probe every process/port until one returns model configs. Remember any
        // valid-but-empty response as a fallback.
        let fallback: ModelQuota[] | null = null;
        for (const { pid, csrf_token } of processes) {
            const ports = await this.getListeningPorts(pid);
            for (const port of ports) {
                try {
                    const data = await this.requestApi(port, csrf_token);
                    const configs = data.clientModelConfigs || [];
                    if (configs.length > 0) {
                        this.cachedPid = pid;
                        this.cachedCsrfToken = csrf_token;
                        this.cachedPort = port;
                        return configs;
                    }
                    if (fallback === null) fallback = configs;
                } catch {
                    continue; // wrong port/proto — try next
                }
            }
        }
        return fallback ?? [];
    }
}

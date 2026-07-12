import { EmbedBuilder } from 'discord.js';
import type { ModelQuota } from '../services/quotaService';

/**
 * Format a single model's quota line: "🟢 Gemini 3.1 Pro (High) — 100% (resets in 45m)".
 */
function formatUsageLine(q: ModelQuota): string {
    const label = q.label || q.model || 'Unknown';
    if (!q.quotaInfo) return `▫️ ${label} — (no quota data)`;

    const rem = q.quotaInfo.remainingFraction;
    const resetTime = q.quotaInfo.resetTime ? new Date(q.quotaInfo.resetTime) : null;
    const diffMs = resetTime ? resetTime.getTime() - Date.now() : 0;

    let timeStr = 'ready';
    if (diffMs > 0) {
        const mins = Math.ceil(diffMs / 60000);
        timeStr =
            mins < 60
                ? `resets in ${mins}m`
                : `resets in ${Math.floor(mins / 60)}h ${mins % 60}m`;
    }

    if (rem !== undefined && rem !== null) {
        const percent = Math.round(rem * 100);
        let icon = '🟢';
        if (percent <= 20) icon = '🔴';
        else if (percent <= 50) icon = '🟡';
        return `${icon} **${label}** — ${percent}% (${timeStr})`;
    }
    return `▫️ **${label}** — (${timeStr})`;
}

/**
 * Build the plain-text body for /usage (used for both the embed description and
 * the plain-text output format).
 */
export function buildUsageText(quotaData: ModelQuota[]): string {
    if (!quotaData || quotaData.length === 0) {
        return '⚠️ No model usage data available. Is Antigravity running and signed in?';
    }
    // Sort by remaining fraction ascending so the most-depleted models surface first.
    const sorted = [...quotaData].sort((a, b) => {
        const ra = a.quotaInfo?.remainingFraction ?? 1;
        const rb = b.quotaInfo?.remainingFraction ?? 1;
        return ra - rb;
    });
    return sorted.map(formatUsageLine).join('\n');
}

/**
 * Build the /usage embed.
 */
export function buildUsageEmbed(quotaData: ModelQuota[]): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle('📊 Model Usage')
        .setColor(0x5865f2)
        .setDescription(buildUsageText(quotaData))
        .setFooter({ text: 'Quota from Antigravity GetUserStatus' })
        .setTimestamp();
}

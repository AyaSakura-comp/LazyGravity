import { isUserAllowed } from '../utils/access';
export const withAuth = (userId: string, allowedUserIds: string[], next: () => void): void => {
    if (isUserAllowed(allowedUserIds, userId)) {
        next();
    }
    return;
};

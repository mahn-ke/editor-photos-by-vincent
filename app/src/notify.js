// Push notifications through Gotify (notifications.by.vincent.mahn.ke). Off unless an
// application token is configured (GOTIFY_TOKEN); every user's notifications go to that one
// Gotify application.

export function createNotifier({ url, token, fetch = globalThis.fetch, log = console }) {
    const enabled = Boolean(url && token);
    return {
        enabled,
        // `click`: opened when the notification is tapped (Gotify's Android app)
        async send({ title, message, click, priority = 5 }) {
            if (!enabled) return false;
            const response = await fetch(`${url}/message`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-gotify-key': token },
                body: JSON.stringify({
                    title, message, priority,
                    extras: click ? { 'client::notification': { click: { url: click } } } : undefined,
                }),
                signal: AbortSignal.timeout(15000),
            });
            await response.body?.cancel();
            if (!response.ok) throw new Error(`Gotify answered ${response.status}`);
            log.info?.(`Notification sent: ${message}`);
            return true;
        },
    };
}

export const suggestionsMessage = n => `${n} new photo suggestion${n === 1 ? '' : 's'} - Tap to open and review!`;

// Background jobs that mean a batch of uploads is still being worked through
const BATCH_KINDS = ['new-asset', 'suggest', 'suggest-backfill'];

// Called after the subjects of new suggestions are prepared, with the user's pending background
// jobs by kind: once the batch has settled, one notification counts the new suggestion cards.
// Without a token nothing is sent, but the suggestions still count as announced, so turning
// notifications on later doesn't announce old ones. A failed send is retried after the next poll.
export function createAnnouncer({ suggester, notifier, baseUrl, log = console }) {
    return async function announce(userId, pending = {}) {
        if (BATCH_KINDS.some(kind => pending[kind])) return 'busy';
        const news = suggester.pendingNotification(userId);
        if (!news.count || !notifier.enabled) {
            suggester.markNotified(userId, news);
            return news.count ? 'disabled' : 'nothing';
        }
        try {
            await notifier.send({ title: 'editor.photos', message: suggestionsMessage(news.count), click: `${baseUrl}/` });
        } catch (error) {
            log.warn(`Notification for ${userId} failed: ${error.message}`);
            return 'failed';
        }
        suggester.markNotified(userId, news);
        return 'sent';
    };
}

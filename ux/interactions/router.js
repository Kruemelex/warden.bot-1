'use strict';

/**
 * @typedef {object} RoutedInteraction
 * @property {object} interaction
 * @property {{action?: string, parts?: string[], state?: object, expired?: boolean}} parsed
 */

/** @typedef {(interaction: object, parts: string[], state: object) => (unknown|Promise<unknown>)} InteractionActionHandler */

/**
 * Route component and modal interactions parsed by a feature-owned custom-ID
 * store. Modal-opening handlers must build entirely from session memory so the
 * interaction can be acknowledged synchronously with showModal().
 *
 * @param {object} options
 * @param {(customId: string) => (object|null)} options.parse
 * @param {Record<string, InteractionActionHandler>} [options.componentActions]
 * @param {Record<string, InteractionActionHandler>} [options.modalActions]
 * @param {(details: RoutedInteraction) => Promise<unknown>} options.onExpired
 * @param {(details: RoutedInteraction) => (boolean|Promise<boolean>)} [options.authorize]
 * @param {(details: RoutedInteraction) => Promise<unknown>} [options.acknowledgeModal]
 * @param {(details: RoutedInteraction & {error: Error}) => Promise<unknown>} options.onComponentError
 * @param {(details: RoutedInteraction & {error: Error}) => Promise<unknown>} options.onModalError
 */
function createInteractionRouter({
    parse,
    componentActions = {},
    modalActions = {},
    onExpired,
    authorize = () => true,
    acknowledgeModal,
    onComponentError,
    onModalError,
} = {}) {
    async function parseInteraction(interaction, kind) {
        const parsed = parse(interaction.customId);
        if (!parsed) return { handled: false };
        if (parsed.expired || (parsed.kind && parsed.kind !== kind)) {
            // Expired routes that still carry their owner/guild boundary must
            // not disclose session state or consume another user's response.
            if (
                (parsed.ownerUserId || parsed.guildId)
                && !await authorize({ interaction, parsed })
            ) return { handled: true };
            await onExpired({ interaction, parsed });
            return { handled: true };
        }
        if (!await authorize({ interaction, parsed })) return { handled: true };
        if (kind === 'form' && parsed.claim && !parsed.claim()) {
            await onExpired({ interaction, parsed });
            return { handled: true };
        }
        return { handled: undefined, parsed };
    }

    async function handleComponent(interaction) {
        const routed = await parseInteraction(interaction, 'action');
        if (routed.handled !== undefined) return routed.handled;
        const { parsed } = routed;
        const handler = componentActions[parsed.action];
        if (!handler) return false;

        try {
            await handler(interaction, parsed.parts, parsed.state);
            return true;
        }
        catch (error) {
            await onComponentError({ interaction, parsed, error });
            return true;
        }
    }

    async function handleModal(interaction) {
        const routed = await parseInteraction(interaction, 'form');
        if (routed.handled !== undefined) return routed.handled;
        const { parsed } = routed;
        const handler = modalActions[parsed.action];
        if (!handler) return false;

        try {
            if (acknowledgeModal) await acknowledgeModal({ interaction, parsed });
            await handler(interaction, parsed.parts, parsed.state);
            return true;
        }
        catch (error) {
            await onModalError({ interaction, parsed, error });
            return true;
        }
    }

    return Object.freeze({
        handleComponent,
        handleModal,
    });
}

module.exports = {
    createInteractionRouter,
};

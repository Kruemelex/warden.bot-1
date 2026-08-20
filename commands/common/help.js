'use strict';

const Discord = require('discord.js');
const {
    botIdent,
    getCommunityEmbedAuthor,
    getIdentityBrandColor,
} = require('../../functions');
const { createUXPanelDocument } = require('../../ux/documents');
const { renderComponentsV2 } = require('../../ux/renderers/componentsV2');
const { createPanelSessionRegistry } = require('../../ux/interactions/sessions');
const { createInteractionRouter } = require('../../ux/interactions/router');
const {
    deferEphemeralReply,
    sanitizeMessageEditOptions,
} = require('../../ux/interactions/acknowledgement');

const HELP_PROFILES = Object.freeze({
    Warden: Object.freeze({
        communityName: 'Anti-Xeno Initiative',
        welcomeThumbnailUrl: 'https://antixenoinitiative.com/wp-content/uploads/2024/09/cropped-AXI_Logo_New2.png',
        welcome: `We are an Elite: Dangerous community centered on Thargoid Combat (Anti-Xeno).
We welcome everyone on our discord server looking to get into AX or simply hang out! https://discord.gg/antixenoinitiative.

Please make sure you checked our <#410089988852547614>. To get started you can visit our <#1054189571614711909> for useful information!`,
        commandsDescription: 'Browse handy commands and resources for our community members!\nWe encourage the use of our <#426833664362414082> channel when exploring and trying out commands!',
        excludedCommandNames: Object.freeze([]),
        categories: Object.freeze([
            Object.freeze({
                id: 'community',
                title: 'Community',
                commandCategories: Object.freeze([]),
                commandNames: Object.freeze(['pg', 'website', 'rtfm', 'squadron']),
                recommendedRoutes: Object.freeze(['pg', 'squadron']),
            }),
            Object.freeze({
                id: 'knowledge',
                title: 'Knowledgebase',
                commandCategories: Object.freeze(['ax-info', 'interceptorcards', 'wiki']),
                commandNames: Object.freeze(['matfarm']),
                recommendedRoutes: Object.freeze(['academy', 'builds', 'findingthargoids', 'wiki', 'graphic']),
            }),
            Object.freeze({
                id: 'tools',
                title: 'Tools',
                commandCategories: Object.freeze(['common', 'math']),
                commandNames: Object.freeze(['invite']),
                recommendedRoutes: Object.freeze(['mttot', 'edsy', 'wtfamhp']),
            }),
            Object.freeze({
                id: 'ranks',
                title: 'Ranks & Medals',
                commandCategories: Object.freeze(['info', 'leaderboards']),
                commandNames: Object.freeze([]),
                recommendedRoutes: Object.freeze(['ranks', 'rankrequirements', 'ranksubmissions', 'leaderboard']),
                rootCommandNames: Object.freeze(['leaderboard']),
            }),
            Object.freeze({
                id: 'fun',
                title: 'Fun',
                commandCategories: Object.freeze(['fun']),
                commandNames: Object.freeze([]),
                recommendedRoutes: Object.freeze(['8ball', 'd20', 'dadjoke']),
            }),
        ]),
    }),
    GuardianAI: Object.freeze({
        communityName: 'Xeno Strike Force',
        welcome: 'We are an Elite: Dangerous community focused on cooperative wing-activities against Thargoids.',
        commandsDescription: 'Browse handy commands and resources for our community members!\nWe encourage the use of our <#1173411628465799239> channel when exploring and trying out commands!',
        excludedCommandNames: Object.freeze([
            'experience',
            'listrole',
            'opord',
            'pg',
            'requestpromotion',
        ]),
        categories: Object.freeze([
            Object.freeze({
                id: 'community',
                title: 'Community',
                commandCategories: Object.freeze([]),
                commandNames: Object.freeze(['website', 'pgo', 'mumble', 'uniform']),
                recommendedRoutes: Object.freeze(['website', 'pgo', 'mumble']),
            }),
            Object.freeze({
                id: 'knowledge',
                title: 'Knowledgebase',
                commandCategories: Object.freeze(['ax-info', 'interceptorcards', 'wiki']),
                commandNames: Object.freeze(['matfarm']),
                recommendedRoutes: Object.freeze(['academy', 'builds', 'findingthargoids', 'wiki', 'graphic']),
            }),
            Object.freeze({
                id: 'tools',
                title: 'Tools',
                commandCategories: Object.freeze(['common', 'math']),
                commandNames: Object.freeze([]),
                recommendedRoutes: Object.freeze(['mttot', 'edsy', 'wtfamhp']),
            }),
            Object.freeze({
                id: 'ranks',
                title: 'Ranks & Medals',
                commandCategories: Object.freeze(['wingChallenges']),
                commandNames: Object.freeze(['promotion']),
                recommendedRoutes: Object.freeze(['promotion information', 'agentsaboteur', 'maelstromdiver']),
            }),
        ]),
    }),
});

const sessions = createPanelSessionRegistry({
    prefix: 'hp',
    label: 'Help',
    maxEntries: 250,
});

function supportsHelpIdentity(botName) {
    return Object.hasOwn(HELP_PROFILES, String(botName ?? ''));
}

function getHelpProfile() {
    const activeBot = botIdent().activeBot;
    const profile = HELP_PROFILES[activeBot?.botName];
    if (!profile || profile.communityName !== activeBot?.communityName) {
        throw new Error('Help is not configured for this bot and community identity.');
    }
    return profile;
}

function collectionValues(collection) {
    if (collection && typeof collection.values === 'function') return [...collection.values()];
    return Array.isArray(collection) ? collection : [];
}

function commandHasPermissionOverride(permissionOverrides, commandId) {
    const permissions = permissionOverrides?.get?.(commandId);
    return Array.isArray(permissions) && permissions.length > 0;
}

function commandRoutes(command, { includeRoot = false } = {}) {
    const routes = [];
    const options = Array.isArray(command.options) ? command.options : [];
    const subcommandType = Discord.ApplicationCommandOptionType.Subcommand;
    const groupType = Discord.ApplicationCommandOptionType.SubcommandGroup;
    const hasSubcommands = options.some((option) => option.type === subcommandType || option.type === groupType);

    if (!hasSubcommands) {
        return [{
            commandName: command.name,
            description: command.description,
            route: command.name,
        }];
    }

    if (includeRoot) {
        routes.push({
            commandName: command.name,
            description: command.description,
            route: command.name,
        });
    }
    for (const option of options) {
        if (option.type === subcommandType) {
            routes.push({
                commandName: command.name,
                description: option.description,
                route: `${command.name} ${option.name}`,
            });
        }
        if (option.type === groupType) {
            for (const subcommand of option.options ?? []) {
                if (subcommand.type !== subcommandType) continue;
                routes.push({
                    commandName: command.name,
                    description: subcommand.description,
                    route: `${command.name} ${option.name} ${subcommand.name}`,
                });
            }
        }
    }
    return routes;
}

function sortCategoryRoutes(routes, recommendedRoutes) {
    const pinnedOrder = new Map(recommendedRoutes.map((route, index) => [route, index]));
    return [...routes].sort((left, right) => {
        const leftIndex = pinnedOrder.get(left.route);
        const rightIndex = pinnedOrder.get(right.route);
        if (leftIndex !== undefined || rightIndex !== undefined) {
            if (leftIndex === undefined) return 1;
            if (rightIndex === undefined) return -1;
            return leftIndex - rightIndex;
        }
        return left.route.localeCompare(right.route);
    });
}

async function loadPublicCommandCatalog(interaction, profile) {
    if (!interaction.guild?.commands || !interaction.client?.commands) {
        throw new Error('Help requires a server command context.');
    }
    const [registeredCommands, permissionOverrides] = await Promise.all([
        interaction.guild.commands.fetch(),
        interaction.guild.commands.permissions.fetch(),
    ]);
    const categoryByCommandCategory = new Map();
    const categoryByCommandName = new Map();
    const excludedCommandNames = new Set(profile.excludedCommandNames ?? []);
    for (const category of profile.categories) {
        for (const commandCategory of category.commandCategories) {
            if (categoryByCommandCategory.has(commandCategory)) {
                throw new Error(`Help command category ${commandCategory} is assigned more than once.`);
            }
            categoryByCommandCategory.set(commandCategory, category.id);
        }
        for (const commandName of category.commandNames) {
            if (categoryByCommandName.has(commandName)) {
                throw new Error(`Help command ${commandName} is assigned more than once.`);
            }
            categoryByCommandName.set(commandName, category.id);
        }
    }

    const routes = [];
    for (const command of collectionValues(registeredCommands)) {
        if (
            command.type !== undefined
            && command.type !== Discord.ApplicationCommandType.ChatInput
        ) continue;
        if (command.defaultMemberPermissions !== null && command.defaultMemberPermissions !== undefined) continue;
        if (commandHasPermissionOverride(permissionOverrides, command.id)) continue;
        if (excludedCommandNames.has(command.name)) continue;

        const localCommand = interaction.client.commands.get(command.name);
        const categoryId = categoryByCommandName.get(command.name)
            ?? categoryByCommandCategory.get(localCommand?.category);
        if (!categoryId) continue;
        const category = profile.categories.find((entry) => entry.id === categoryId);
        const includeRoot = category.rootCommandNames?.includes(command.name) === true;
        for (const route of commandRoutes(command, { includeRoot })) routes.push({ ...route, categoryId });
    }

    const seenRoutes = new Set();
    return routes.filter((route) => {
        if (seenRoutes.has(route.route)) return false;
        seenRoutes.add(route.route);
        return true;
    });
}

function formatCommandList(routes) {
    return routes.map((route) => `- \`/${route.route}\` — ${route.description}`).join('\n');
}

function getRoute(catalog, routeName) {
    return catalog.find((entry) => entry.route === routeName);
}

function getCategoryRoutes(catalog, category) {
    const routes = catalog.filter((entry) => entry.categoryId === category.id);
    for (const routeName of category.recommendedRoutes) {
        const recommended = getRoute(catalog, routeName);
        if (recommended && recommended.categoryId !== category.id) {
            throw new Error(`Help route /${routeName} is recommended outside its assigned category.`);
        }
    }
    return sortCategoryRoutes(routes, category.recommendedRoutes);
}

function buildToggleButton(session, category, expanded) {
    return new Discord.ButtonBuilder()
        .setCustomId(session.buildState('toggle', [category.id], { categoryId: category.id }))
        .setLabel(expanded ? 'Show Less' : 'Show More')
        .setStyle(Discord.ButtonStyle.Secondary);
}

function renderHelpPanel(state) {
    const { catalog, expandedCategoryIds, profile, session } = state;
    const editorBlocks = [{
        kind: 'text',
        content: `## Commands\n${profile.commandsDescription}`,
    }];
    for (const category of profile.categories) {
        const routes = getCategoryRoutes(catalog, category);
        if (routes.length < 1) continue;
        const expanded = expandedCategoryIds.has(category.id);
        const previewCount = category.recommendedRoutes.length;
        editorBlocks.push({
            kind: 'section',
            content: [`### ${category.title}\n${formatCommandList(expanded ? routes : routes.slice(0, previewCount))}`],
            accessory: routes.length > previewCount
                ? buildToggleButton(session, category, expanded)
                : undefined,
        });
    }

    const document = createUXPanelDocument({
        title: `Welcome to the ${profile.communityName}`,
        description: profile.welcome,
        accentColor: getIdentityBrandColor(),
        thumbnailUrl: profile.welcomeThumbnailUrl ?? getCommunityEmbedAuthor().iconURL,
        editorBlocks,
        ephemeral: true,
    });
    return sanitizeMessageEditOptions(renderComponentsV2(document).payload);
}

async function toggleCategory(interaction, _parts, state) {
    const categoryId = state.categoryId;
    const knownCategory = state.profile.categories.some((category) => category.id === categoryId);
    if (!knownCategory) throw new Error('Unknown Help category.');
    if (state.expandedCategoryIds.has(categoryId)) state.expandedCategoryIds.delete(categoryId);
    else state.expandedCategoryIds.add(categoryId);
    return interaction.update(renderHelpPanel(state));
}

async function respondPrivate(interaction, content) {
    const payload = { content, flags: Discord.MessageFlags.Ephemeral };
    if (interaction.deferred) return interaction.editReply(sanitizeMessageEditOptions(payload));
    if (interaction.replied) return interaction.followUp(payload);
    return interaction.reply(payload);
}

const router = createInteractionRouter({
    parse: sessions.parse,
    componentActions: { toggle: toggleCategory },
    authorize: async ({ interaction, parsed }) => {
        if (
            String(interaction.user?.id) !== String(parsed.ownerUserId)
            || String(interaction.guildId) !== String(parsed.guildId)
        ) {
            await respondPrivate(interaction, 'This Help panel belongs to another user or server.');
            return false;
        }
        return true;
    },
    onExpired: ({ interaction }) => respondPrivate(interaction, 'This Help panel expired. Run `/help` again.'),
    onComponentError: ({ interaction }) => respondPrivate(
        interaction,
        'The Help panel could not be updated. Run `/help` again.',
    ),
    onModalError: ({ interaction }) => respondPrivate(interaction, 'The Help panel action failed.'),
});

async function execute(interaction) {
    await deferEphemeralReply(interaction);
    try {
        const profile = getHelpProfile();
        const catalog = await loadPublicCommandCatalog(interaction, profile);
        const state = {
            catalog,
            expandedCategoryIds: new Set(),
            profile,
        };
        state.session = sessions.create({
            guildId: interaction.guildId,
            ownerUserId: interaction.user.id,
            state,
        });
        return interaction.editReply(renderHelpPanel(state));
    }
    catch (error) {
        return interaction.editReply({
            content: 'Help is unavailable right now. Please try again shortly.',
        });
    }
}

function handleInteraction(interaction) {
    if (interaction.isButton?.()) return router.handleComponent(interaction);
    return false;
}

module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName('help')
        .setDescription('Browse commands and community information')
        .setContexts(Discord.InteractionContextType.Guild),
    permissions: 0,
    registrationScope: 'global',
    supportedBotIdentities: Object.freeze(['Warden', 'GuardianAI']),
    execute,
    handleInteraction,
    commandRoutes,
    getCategoryRoutes,
    loadPublicCommandCatalog,
    renderHelpPanel,
    sortCategoryRoutes,
    supportsHelpIdentity,
};

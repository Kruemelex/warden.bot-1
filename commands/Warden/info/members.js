'use strict';

const Discord = require('discord.js');
const config = require('../../../config.json');
const { cleanString } = require('../../../functions');
const {
    RoleMemberCache,
    RoleMemberCacheError,
    getAllowedGuildRoles,
} = require('../../../Warden/members/roleMemberCache');

const memberCache = new RoleMemberCache();

function getMembersConfiguration() {
    return {
        ranksCommand: config.Warden?.ranksCommand,
        membersCommand: config.Warden?.membersCommand,
    };
}

function getInteractionOption(interaction, name, type, required = false) {
    const getter = interaction.options?.[`get${type}`];
    if (typeof getter === 'function') return getter.call(interaction.options, name, required);
    const value = interaction.options?.data?.find((option) => option.name === name)?.value;
    if (required && (value === undefined || value === null)) {
        throw new RoleMemberCacheError(`The ${name} option is required.`, 'MISSING_OPTION');
    }
    return value;
}

function getAllowedRolesForGuild(guild) {
    return getAllowedGuildRoles({
        roleCache: guild?.roles?.cache,
        ...getMembersConfiguration(),
    });
}

function csvEscape(value) {
    const raw = String(value ?? '');
    const string = /^[=+\-@]/u.test(raw) ? `'${raw}` : raw;
    return /[",\r\n]/u.test(string) ? `"${string.replace(/"/gu, '""')}"` : string;
}

function recordValue(record, type) {
    switch (type) {
        case 'tag': return record.tag;
        case 'username': return record.username;
        case 'id': return record.id;
        case 'nickname': return record.displayName;
        default: throw new RoleMemberCacheError('Wrong file type!', 'INVALID_OUTPUT_TYPE');
    }
}

function recordsForRole(snapshot, roleId) {
    const ids = snapshot.memberIdsByRole.get(roleId) ?? new Set();
    return Array.from(ids, (id) => snapshot.membersById.get(id)).filter(Boolean);
}

function attachment(buffer, name) {
    return new Discord.AttachmentBuilder(buffer, { name });
}

async function respondWithError(interaction, error) {
    const expected = error instanceof RoleMemberCacheError;
    if (!expected) console.error(error);
    const content = expected
        ? `⚠️ ${error.message}`
        : 'Something went wrong while preparing the member list.';
    if (typeof interaction.editReply === 'function') return interaction.editReply({ content });
    return interaction.reply({ content, flags: Discord.MessageFlags.Ephemeral });
}

module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName('members')
        .setDescription('Lists the tag/username/id/nickname(default = nickname) of members with a configured rank.')
        .addStringOption((option) => option.setName('role')
            .setDescription('The configured rank to target')
            .setRequired(true)
            .setAutocomplete(true))
        .addStringOption((option) => option.setName('output')
            .setDescription('How to output the data')
            .setRequired(true)
            .addChoices(
                { name: 'CSV', value: 'csv' },
                { name: 'TXT', value: 'txt' },
            ))
        .addStringOption((option) => option.setName('type')
            .setDescription('Type of data to list')
            .setRequired(true)
            .addChoices(
                { name: 'Tag', value: 'tag' },
                { name: 'Username', value: 'username' },
                { name: 'ID', value: 'id' },
                { name: 'Nickname', value: 'nickname' },
            ))
        .addIntegerOption((option) => option.setName('maxlength')
            .setDescription('Total number to list')
            .setRequired(false)),
    permissions: 0,

    async autocomplete(interaction) {
        const focused = interaction.options.getFocused(true);
        if (focused.name !== 'role') return interaction.respond([]);

        try {
            const needle = String(focused.value ?? '').toLocaleLowerCase();
            const choices = getAllowedRolesForGuild(interaction.guild)
                .filter((role) => role.name.toLocaleLowerCase().includes(needle))
                .slice(0, 25)
                .map((role) => ({ name: role.name, value: role.id }));
            return interaction.respond(choices);
        }
        catch (error) {
            console.error('Unable to resolve /members autocomplete roles:', error.message);
            return interaction.respond([]);
        }
    },

    async execute(interaction) {
        await interaction.deferReply();
        try {
            const roleId = String(getInteractionOption(interaction, 'role', 'String', true));
            const output = getInteractionOption(interaction, 'output', 'String', true);
            const type = getInteractionOption(interaction, 'type', 'String', true);
            const maxLength = getInteractionOption(interaction, 'maxlength', 'Integer') ?? 10;
            const allowedRoles = getAllowedRolesForGuild(interaction.guild);
            const role = allowedRoles.find((candidate) => candidate.id === roleId);
            if (!role) {
                throw new RoleMemberCacheError(
                    'That role is not available through /members.',
                    'ROLE_NOT_ALLOWED',
                );
            }

            const snapshot = await memberCache.getSnapshot(interaction.guild, allowedRoles);
            const records = recordsForRole(snapshot, role.id);
            const actualRole = cleanString(role.name);

            if (output === 'csv') {
                const rows = [
                    'Discord tag,Discord Username,Discord Id,Server Nickname/displayName',
                    ...records.map((record) => [
                        record.tag,
                        record.username,
                        record.id,
                        record.displayName,
                    ].map(csvEscape).join(',')),
                ];
                return interaction.editReply({
                    content: "Here's your CSV file:",
                    files: [attachment(Buffer.from(`${rows.join('\n')}\n`, 'utf8'), 'memberlist.csv')],
                });
            }

            if (output !== 'txt') {
                throw new RoleMemberCacheError('Wrong file type!', 'INVALID_OUTPUT_TYPE');
            }

            if (!records.length) {
                return interaction.editReply({ content: `No members found with role ${actualRole}.` });
            }

            const values = records.map((record) => recordValue(record, type));
            const memberList = `${values.join('\n')}\n`;
            const embedValue = values.join('\n');
            if (records.length <= maxLength && embedValue.length <= 1024) {
                const returnEmbed = new Discord.EmbedBuilder()
                    .setColor('#FF7100')
                    .setTitle('**Member List**')
                    .addFields({
                        name: `List of members holding rank ${actualRole}:`,
                        value: `**${embedValue}**`,
                    })
                    .setTimestamp();
                return interaction.editReply({ embeds: [returnEmbed] });
            }

            return interaction.editReply({
                content: `Members List longer than ${maxLength}!\nSending the ${type} in a txt file:`,
                files: [attachment(Buffer.from(memberList, 'utf8'), 'memberlist.txt')],
            });
        }
        catch (error) {
            return respondWithError(interaction, error);
        }
    },

    _private: {
        csvEscape,
        getAllowedRolesForGuild,
        recordsForRole,
    },
};

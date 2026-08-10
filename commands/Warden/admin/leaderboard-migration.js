'use strict';

const Discord = require('discord.js');
const { createConsoleReporter } = require('../../../consoleReporting');
const {
    inspectLegacyLeaderboards,
    migrateLegacyLeaderboards,
    withDatabaseMigrationLock,
} = require('../../../Warden/db/leaderboards/migration');
const { runExclusiveLeaderboardMigration } = require('../../../Warden/db/leaderboards/migrationGuard');

const report = createConsoleReporter('Warden').forSubsystem('Leaderboard migration');

function formatCounts(counts) {
    return [
        `Speedrun: legacy **${counts.speedrun.legacyRows}**, encrypted **${counts.speedrun.encryptedRows}**, missing **${counts.speedrun.missingRows}**.`,
        `Ace: legacy **${counts.ace.legacyRows}**, encrypted **${counts.ace.encryptedRows}**, missing **${counts.ace.missingRows}**.`,
    ].join('\n');
}

function formatMigrationResult(result) {
    return [
        `Speedrun: **${result.speedrun.copied} copied**, ${result.speedrun.skipped} already matched.`,
        `Ace: **${result.ace.copied} copied**, ${result.ace.skipped} already matched.`,
        formatCounts(result.audit),
        'Legacy rows were not changed or deleted.',
    ].join('\n');
}

function createMigrationExecutor({
    inspect = inspectLegacyLeaderboards,
    migrate = migrateLegacyLeaderboards,
    lock = withDatabaseMigrationLock,
    run = runExclusiveLeaderboardMigration,
} = {}) {
    return async function execute(interaction) {
        if (!interaction.inGuild?.()
            || !interaction.memberPermissions?.has(Discord.PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '⛔ This command requires the Administrator permission.',
                flags: Discord.MessageFlags.Ephemeral,
            });
        }

        await interaction.deferReply({ flags: Discord.MessageFlags.Ephemeral });
        const action = interaction.options.getSubcommand();
        if (action === 'execute' && interaction.options.getString('confirmation', true) !== 'MIGRATE') {
            return interaction.editReply({ content: '⛔ Confirmation must be exactly `MIGRATE`.' });
        }

        try {
            const result = await run(() => lock(() => (
                action === 'dry-run'
                    ? inspect()
                    : migrate({
                        onProgress: (progress) => report.neutral('Copy progress', progress),
                    })
            )));
            if (action === 'dry-run') {
                report.success('Preflight passed', result);
                return interaction.editReply({
                    content: `✅ Leaderboard migration preflight passed. No Leaderboard rows were copied.\n${formatCounts(result)}`,
                });
            }
            report.complete('Migration and audit completed', result);
            return interaction.editReply({
                content: `✅ Leaderboard migration and post-copy audit completed.\n${formatMigrationResult(result)}\n\nRemove \`WARDEN_LEADERBOARD_MIGRATION_MODE\` and restart Warden to restore commands and reconcile pending approval posts.`,
            });
        }
        catch (error) {
            report.error(`${action === 'dry-run' ? 'Preflight' : 'Migration'} failed`, error);
            return interaction.editReply({
                content: `⛔ Leaderboard migration ${action === 'dry-run' ? 'preflight' : 'execution'} failed: ${error.message}`,
            });
        }
    };
}

module.exports = {
    data: new Discord.SlashCommandBuilder()
        .setName('leaderboard-migration')
        .setDescription('Preflight or execute the one-time encrypted Leaderboard migration')
        .setDMPermission(false)
        .setDefaultMemberPermissions(Discord.PermissionFlagsBits.Administrator)
        .addSubcommand((subcommand) => subcommand
            .setName('dry-run')
            .setDescription('Validate both Leaderboards without copying rows'))
        .addSubcommand((subcommand) => subcommand
            .setName('execute')
            .setDescription('Copy and verify both Leaderboards')
            .addStringOption((option) => option
                .setName('confirmation')
                .setDescription('Enter MIGRATE to confirm')
                .setRequired(true))),
    createMigrationExecutor,
    execute: createMigrationExecutor(),
    formatCounts,
    formatMigrationResult,
};

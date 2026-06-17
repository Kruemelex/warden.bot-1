const Discord = require("discord.js");

const critFailLines = [
    "Your weapon slips out of your hand and lands directly on your foot.",
    "You trip over your own shadow.",
    "The die rolled a 1 because it pities you.",
    "Somewhere, a bard is already writing a song about this.",
    "You manage to disappoint everyone, including yourself.",
    "Even the DM winced.",
    "You hit yourself with your own weapon. Impressive, actually.",
    "The universe collectively facepalms.",
    "You stub your toe on absolutely nothing.",
    "Your confidence was the real critical failure here.",
    "Somewhere a wizard lost faith in humanity.",
    "You fumble so hard the die rolls itself off the table in protest.",
    "Your character sheet quietly weeps.",
    "You attempt something heroic. You achieve something hilarious.",
    "Legends will not be told about this.",
    "You roll a 1, and the table goes silent.",
    "Somehow, you make this worse than anyone expected.",
    "Your plan was flawless. Your execution was not.",
    "You manage to fail in a way no one anticipated.",
    "The gods of fate are laughing at you right now.",
    "This is why you're not allowed near sharp objects.",
    "You fail spectacularly, and somehow gracefully.",
    "Nat 1. Of course.",
    "You step on a rake that wasn't even there.",
    "Even your shadow is embarrassed for you.",
    "This will absolutely be brought up at your funeral.",
    "Your party quietly considers replacing you with a goat.",
    "You roll so badly the die apologizes.",
    "Somewhere, a cleric sighs and reaches for healing potions.",
    "You attempt the impossible and somehow undersell it.",
    "Critical failure: you have unlocked a new tier of incompetence.",
    "The bard already has three verses written.",
    "You roll a 1. The universe takes notes.",
    "This is now a cautionary tale.",
    "Somewhere, your ancestors are disowning you.",
    "You fail so hard it loops back around to impressive.",
    "Even luck refuses to associate with you right now.",
    "You roll a 1. Bards rejoice. Heroes weep.",
    "Your dice are now banned from future sessions.",
    "Someone, somewhere, just lost faith in fate itself.",
    "You roll a 1, and somehow trip while standing still.",
    "This failure has been added to the campaign's official lore.",
    "You roll a 1. Your DM smiles a little too wide.",
    "Somehow, you've made failure into an art form.",
    "Your weapon, your dignity, and your plan all hit the floor at once.",
    "You roll a 1. Somewhere, a goblin is taking notes.",
    "This will be referenced in every future session, forever.",
    "You roll a 1, and the narrator pauses just to sigh.",
    "Your character briefly considers a career change.",
    "Critical failure achieved. Achievement unlocked: Maximum Chaos."
];

module.exports = {
    data: new Discord.SlashCommandBuilder()
    .setName(`d20`)
    .setDescription(`Roll a d20. Spoiler: you already know how this ends.`),
    // .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    permissions:0,

    async execute(interaction) {
        try
        {
            let line = critFailLines[Math.floor(Math.random() * critFailLines.length)];
            await interaction.reply({content: `You roll a 1. Critical Failure. ${line}`})
        }

        catch (err) {
            console.log(err);
            interaction.reply({ content: `Something went wrong!\nERROR: ${err}` });
        }
    }
}

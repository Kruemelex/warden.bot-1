const verificationAdmin = require('../../../Warden/verification/admin/controller');

module.exports = {
    data: verificationAdmin.buildVerificationCommandData(
        'verification-challenges',
        'Browse and edit verification challenges',
    ),
    execute(interaction) {
        return verificationAdmin.executeVerificationAdminCommand(interaction, 'challenges');
    },
};

const verificationAdmin = require('../../../Warden/verification/admin/controller');

module.exports = {
    data: verificationAdmin.buildVerificationCommandData(
        'verification-settings',
        'Show and edit verification settings',
    ),
    execute(interaction) {
        return verificationAdmin.executeVerificationAdminCommand(interaction, 'settings');
    },
};

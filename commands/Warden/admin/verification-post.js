const verificationAdmin = require('../../../Warden/verification/admin/controller');

module.exports = {
    data: verificationAdmin.buildVerificationPostCommandData(),
    execute(interaction) {
        return verificationAdmin.executeVerificationAdminCommand(interaction, 'post');
    },
};

'use strict';

const Discord = require('discord.js');

function snapshotMessageComponents(message) {
    const components = (message?.components ?? []).map((component) => component?.toJSON?.() ?? component);
    return JSON.parse(JSON.stringify(components));
}

function cloneComponents(components = []) {
    return JSON.parse(JSON.stringify(components));
}

function buildLoadingComponents(components, clickedCustomId, { label = '...' } = {}) {
    const loading = cloneComponents(components);
    const visit = (component) => {
        if (component?.custom_id) {
            component.disabled = true;
            if (component.type === Discord.ComponentType.Button && component.custom_id === clickedCustomId) {
                component.label = label;
                delete component.emoji;
            }
        }
        for (const child of component?.components ?? []) visit(child);
        if (component?.accessory) visit(component.accessory);
    };
    for (const component of loading) visit(component);
    return loading;
}

module.exports = {
    buildLoadingComponents,
    snapshotMessageComponents,
};

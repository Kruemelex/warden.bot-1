const mutations = new Map();

function enqueueGuildWork(queue, guildId, work) {
    const key = String(guildId);
    const previous = queue.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    queue.set(key, next);
    return next.finally(() => {
        if (queue.get(key) === next) queue.delete(key);
    });
}

function runGuildMutation(guildId, work) {
    return enqueueGuildWork(mutations, guildId, work);
}

function drainGuildMutations() {
    return Promise.allSettled([...mutations.values()]);
}

module.exports = { enqueueGuildWork, runGuildMutation, drainGuildMutations };

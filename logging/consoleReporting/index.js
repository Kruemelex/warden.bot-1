'use strict';

const util = require('node:util');
const colors = require('colors/safe');

const ACTION_COLORS = Object.freeze({
    complete: colors.cyan,
    error: colors.red,
    neutral: (value) => value,
    success: colors.green,
    warning: colors.yellow,
});

function normalizeLabel(value, name) {
    const label = String(value ?? '').trim().replace(/:+$/, '');
    if (!label) throw new TypeError(`Console reporter requires a ${name}.`);
    return label;
}

function normalizeAction(value) {
    return String(value ?? '').trim().replace(/:+$/, '');
}

function buildConsoleReportMessage(feature, subsystem, action) {
    const source = normalizeLabel(feature, 'feature');
    const scope = normalizeLabel(subsystem, 'subsystem');
    return `${source} ${scope}: ${normalizeAction(action)}`.trimEnd();
}

function formatConsoleReportKey(key) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(key) ? key : JSON.stringify(key);
}

function isConsoleReportRecord(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function formatConsoleReportDescriptor(descriptor, inspectOptions) {
    if (Object.hasOwn(descriptor, 'value')) {
        return util.inspect(descriptor.value, inspectOptions);
    }
    const label = descriptor.get && descriptor.set
        ? '[Getter/Setter]'
        : descriptor.get ? '[Getter]' : descriptor.set ? '[Setter]' : undefined;
    if (label === undefined) return util.inspect(undefined, inspectOptions);
    return inspectOptions.colors ? colors.cyan(label) : label;
}

function formatConsoleReportData(data, { colorsEnabled = true } = {}) {
    if (data === undefined) return undefined;
    const inspectOptions = {
        breakLength: Infinity,
        colors: colorsEnabled,
        compact: true,
        depth: 5,
        sorted: false,
    };
    if (!isConsoleReportRecord(data)) {
        return util.inspect(data, inspectOptions);
    }
    const entries = Object.entries(Object.getOwnPropertyDescriptors(data))
        .filter(([, descriptor]) => descriptor.enumerable);
    if (entries.length < 1) return '{}';
    const formattedEntries = entries.map(([key, descriptor]) => (
        `${formatConsoleReportKey(key)}: ${formatConsoleReportDescriptor(descriptor, inspectOptions)}`
    ));
    const hasGroupedDatapoints = entries.some(([, descriptor]) => (
        Object.hasOwn(descriptor, 'value') && isConsoleReportRecord(descriptor.value)
    ));
    if (!hasGroupedDatapoints) return `{ ${formattedEntries.join(', ')} }`;
    return `{
${formattedEntries.map((entry) => `  ${entry}`).join(',\n')}
}`;
}

function createConsoleReporter(feature, {
    colorsEnabled = true,
    sink = console,
} = {}) {
    const source = normalizeLabel(feature, 'feature');

    function forSubsystem(subsystem) {
        const scope = normalizeLabel(subsystem, 'subsystem');

        function write(level, style, action, { data, error } = {}) {
            const output = sink[level] ?? sink.log;
            if (typeof output !== 'function') {
                throw new TypeError(`Console reporter sink does not support ${level}.`);
            }
            const plainAction = normalizeAction(action);
            const prefix = `${source} ${scope}:`;
            const message = colorsEnabled
                ? `${colors.magenta(prefix)} ${ACTION_COLORS[style](plainAction)}`.trimEnd()
                : `${prefix} ${plainAction}`.trimEnd();
            const args = [message];
            const formattedData = formatConsoleReportData(data, { colorsEnabled });
            if (formattedData !== undefined) args.push(formattedData);
            if (error !== undefined) args.push(error);
            output.apply(sink, args);
        }

        return Object.freeze({
            complete: (action, data) => write('info', 'complete', action, { data }),
            error: (action, error, data) => write('error', 'error', action, { data, error }),
            neutral: (action, data) => write('info', 'neutral', action, { data }),
            success: (action, data) => write('info', 'success', action, { data }),
            warn: (action, error, data) => write('warn', 'warning', action, { data, error }),
        });
    }

    return Object.freeze({ forSubsystem });
}

function logConsoleStartupStatus(botName, label, status, {
    failed = false,
    error,
    sink = console,
} = {}) {
    const method = failed || error !== undefined ? 'error' : 'log';
    const output = sink[method];
    if (typeof output !== 'function') {
        throw new TypeError(`Startup console sink does not support ${method}.`);
    }
    const args = [
        colors.yellow('[STARTUP]'),
        colors.green(String(botName)),
        colors.magenta(`${normalizeLabel(label, 'startup label')}:`),
        status,
    ];
    if (error !== undefined) args.push(error);
    output.apply(sink, args);
}

module.exports = {
    buildConsoleReportMessage,
    createConsoleReporter,
    formatConsoleReportData,
    logConsoleStartupStatus,
};

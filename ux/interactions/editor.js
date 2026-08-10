'use strict';

/**
 * @template TContext, TObject, TValues, TEdits, TResult
 * @typedef {object} AdminEditorDetails
 * @property {string} name
 * @property {AdminEditorDescriptor<TContext, TObject, TValues, TEdits, TResult>} descriptor
 * @property {TContext} context
 * @property {TObject} object The latest object loaded for the current phase.
 * @property {object} interaction
 * @property {string[]} parts
 * @property {object} state
 * @property {unknown} [acknowledgement]
 */

/**
 * @template TContext, TObject, TValues, TEdits, TResult
 * @typedef {object} AdminEditorDescriptor
 * @property {string} action Modal-submit action.
 * @property {string} [title]
 * @property {(details: AdminEditorDetails<TContext, TObject, TValues, TEdits, TResult> & {phase: 'open'|'submit'}) => (string|undefined|Promise<string|undefined>)} [available]
 * @property {(details: AdminEditorDetails<TContext, TObject, TValues, TEdits, TResult>) => (AdminEditorForm|undefined|Promise<AdminEditorForm|undefined>)} build
 * @property {(details: AdminEditorDetails<TContext, TObject, TValues, TEdits, TResult>) => (TValues|Promise<TValues>)} read
 * @property {(details: AdminEditorDetails<TContext, TObject, TValues, TEdits, TResult> & {values: TValues}) => (string|undefined|Promise<string|undefined>)} [validateValues]
 * @property {(details: AdminEditorDetails<TContext, TObject, TValues, TEdits, TResult> & {values: TValues}) => (TEdits|Promise<TEdits>)} resolve
 * @property {(details: AdminEditorDetails<TContext, TObject, TValues, TEdits, TResult> & {values: TValues, edits: TEdits}) => (boolean|Promise<boolean>)} [hasChanges]
 * @property {(details: AdminEditorDetails<TContext, TObject, TValues, TEdits, TResult> & {values: TValues, edits: TEdits}) => (string|undefined|Promise<string|undefined>)} [validate]
 * @property {(details: AdminEditorDetails<TContext, TObject, TValues, TEdits, TResult> & {values: TValues, edits: TEdits, actorId: string|undefined}) => (TResult|Promise<TResult>)} commit Must retain database-level concurrency protection.
 */

/**
 * @typedef {object} AdminEditorForm
 * @property {string} [title]
 * @property {unknown[]} [fields]
 * @property {object} [baseline]
 */

/**
 * @template TContext
 * @typedef {object} AdminSubmission
 * @property {TContext} [context] Fresh submit-time context. When omitted, the submission itself is the context.
 * @property {unknown} [acknowledgement]
 * @property {unknown} [responseMode]
 * @property {boolean} [failed] A true value means the adapter already handled the response.
 */

/**
 * @template TContext, TObject, TValues, TEdits, TResult
 * @typedef {object} DescriptorModalEditorOptions
 * @property {Record<string, AdminEditorDescriptor<TContext, TObject, TValues, TEdits, TResult>>} descriptors
 * @property {(details: object) => (TContext|undefined|Promise<TContext|undefined>)} loadOpenContext
 * @property {(details: object) => (AdminSubmission<TContext>|TContext|undefined|Promise<AdminSubmission<TContext>|TContext|undefined>)} beginSubmission Must acknowledge before slow submit-time reads.
 * @property {(context: TContext) => TObject} [getObject]
 * @property {(details: AdminEditorDetails<TContext, TObject, TValues, TEdits, TResult> & {form: AdminEditorForm}) => (string[]|Promise<string[]>)} getModalParts
 * @property {(details: object) => string} buildCustomId
 * @property {(details: object) => unknown} buildModal
 * @property {(details: object) => unknown} respondError
 * @property {(details: object) => unknown} respondNoChanges
 * @property {(details: AdminEditorDetails<TContext, TObject, TValues, TEdits, TResult> & {values: TValues, edits: TEdits, result: TResult}) => unknown} complete
 */

/**
 * @typedef {object} DescriptorModalEditor
 * @property {(name: string, interaction: object, parts?: string[], state?: object) => Promise<unknown>} open
 * @property {(name: string, interaction: object, parts?: string[], state?: object) => Promise<unknown>} submit
 */

/**
 * Compose descriptor-driven modal open/submit lifecycles. A falsy or failed
 * context means the feature adapter already handled the response. Submission
 * adapters must acknowledge before slow reads and re-fetch the edited object;
 * field-level optimistic edits do not replace database compare-and-swap.
 *
 * @template TContext, TObject, TValues, TEdits, TResult
 * @param {DescriptorModalEditorOptions<TContext, TObject, TValues, TEdits, TResult>} options
 * @returns {DescriptorModalEditor}
 */
function createDescriptorModalEditor(options = {}) {
    const {
        descriptors,
        loadOpenContext,
        beginSubmission,
        getObject = (context) => context.object,
        getModalParts,
        buildCustomId,
        buildModal,
        respondError,
        respondNoChanges,
        complete,
    } = options;
    function getDescriptor(name) {
        const descriptor = descriptors?.[name];
        if (!descriptor) throw new Error(`Unknown admin modal editor: ${name}`);
        return descriptor;
    }

    async function getAvailabilityError(descriptor, phase, details) {
        if (typeof descriptor.available !== 'function') return undefined;
        return descriptor.available({ phase, ...details });
    }

    async function open(name, interaction, parts = [], state = {}) {
        const descriptor = getDescriptor(name);
        const context = await loadOpenContext({ name, descriptor, interaction, parts, state });
        if (!context || context.error || context.failed) return undefined;
        const object = getObject(context);
        const details = { name, descriptor, context, object, interaction, parts, state };
        const availabilityError = await getAvailabilityError(descriptor, 'open', details);
        if (availabilityError) throw new Error(availabilityError);

        const form = await descriptor.build(details);
        if (!form) return undefined;
        const modalParts = await getModalParts({ ...details, form });
        const customId = buildCustomId({
            ...details,
            action: descriptor.action,
            modalParts,
            baseline: form.baseline ?? {},
            form,
        });
        const modal = buildModal({
            ...details,
            customId,
            title: form.title ?? descriptor.title,
            fields: form.fields ?? [],
            form,
        });
        return interaction.showModal(modal);
    }

    async function submit(name, interaction, parts = [], state = {}) {
        const descriptor = getDescriptor(name);
        const submission = await beginSubmission({ name, descriptor, interaction, parts, state });
        if (!submission || submission.failed) return undefined;
        const context = submission.context ?? submission;
        const acknowledgement = submission.acknowledgement ?? submission.responseMode;
        const object = getObject(context);
        const details = {
            name,
            descriptor,
            context,
            object,
            interaction,
            parts,
            state,
            acknowledgement,
        };

        const availabilityError = await getAvailabilityError(descriptor, 'submit', details);
        if (availabilityError) {
            return respondError({ ...details, message: availabilityError });
        }

        let values;
        let edits;
        try {
            values = await descriptor.read(details);
            const valuesError = await descriptor.validateValues?.({ ...details, values });
            if (valuesError) return respondError({ ...details, values, message: valuesError });

            edits = await descriptor.resolve({ ...details, values });
            const changed = descriptor.hasChanges
                ? await descriptor.hasChanges({ ...details, values, edits })
                : Object.values(edits ?? {}).some((edit) => edit?.changed === true);
            if (!changed) return respondNoChanges({ ...details, values, edits });

            const validationError = await descriptor.validate?.({ ...details, values, edits });
            if (validationError) {
                return respondError({ ...details, values, edits, message: validationError });
            }
        }
        catch (error) {
            return respondError({ ...details, values, edits, error, message: error.message });
        }

        const result = await descriptor.commit({
            ...details,
            values,
            edits,
            actorId: interaction.user?.id,
        });
        return complete({ ...details, values, edits, result });
    }

    return Object.freeze({
        open,
        submit,
    });
}

module.exports = {
    createDescriptorModalEditor,
};

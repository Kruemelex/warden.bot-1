/**
 * A small, domain-neutral admission primitive.
 *
 * Lower numeric priorities run first. The named priorities are live (0),
 * admin (1), and background (2); jobs with the same priority are FIFO.
 * Queue timeouts and AbortSignals apply only before a job receives capacity.
 */
const PRIORITY_SEMAPHORE_PRIORITIES = Object.freeze({
    live: 0,
    admin: 1,
    background: 2,
});
const DEFAULT_PRIORITY_SEMAPHORE_MAX_PENDING = 64;

function createAdmissionError(message, code, name = 'PrioritySemaphoreError') {
    const error = new Error(message);
    error.name = name;
    error.code = code;
    return error;
}

function normalizePriority(priority) {
    if (typeof priority === 'string' && Object.hasOwn(PRIORITY_SEMAPHORE_PRIORITIES, priority)) {
        return PRIORITY_SEMAPHORE_PRIORITIES[priority];
    }
    if (typeof priority === 'number' && Number.isFinite(priority)) return priority;
    throw new TypeError('Priority must be a finite number or live, admin, or background.');
}

class PrioritySemaphore {
    constructor({ capacity = 1, maxPending = DEFAULT_PRIORITY_SEMAPHORE_MAX_PENDING } = {}) {
        if (!Number.isInteger(capacity) || capacity < 1) {
            throw new RangeError('Semaphore capacity must be a positive integer.');
        }
        if (!Number.isInteger(maxPending) || maxPending < 0) {
            throw new RangeError('Semaphore maxPending must be a non-negative integer.');
        }

        Object.defineProperties(this, {
            capacity: { enumerable: true, value: capacity },
            maxPending: { enumerable: true, value: maxPending },
        });
        this.active = 0;
        this.nextSequence = 0;
        this.queue = [];
    }

    getStats() {
        return Object.freeze({
            active: this.active,
            capacity: this.capacity,
            queued: this.queue.length,
            maxPending: this.maxPending,
        });
    }

    acquire({ priority = 'admin', timeoutMs, signal } = {}) {
        let normalizedPriority;
        try {
            normalizedPriority = normalizePriority(priority);
        }
        catch (error) {
            return Promise.reject(error);
        }

        if (signal?.aborted) return Promise.reject(signal.reason || createAdmissionError(
            'Semaphore admission was aborted before it was queued.',
            'PRIORITY_SEMAPHORE_ABORTED',
            'AbortError',
        ));
        if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
            return Promise.reject(new RangeError('Semaphore queue timeout must be a positive number.'));
        }
        if (this.active < this.capacity && this.queue.length === 0) {
            return Promise.resolve(this.#createRelease());
        }
        if (this.queue.length >= this.maxPending) {
            const queueFullError = () => createAdmissionError(
                `Semaphore queue is full (${this.maxPending} jobs pending).`,
                'PRIORITY_SEMAPHORE_QUEUE_FULL',
            );
            const worstQueuedJob = this.queue.reduce((worst, job) => (
                !worst
                || job.priority > worst.priority
                || (job.priority === worst.priority && job.sequence > worst.sequence)
                    ? job
                    : worst
            ), undefined);
            if (!worstQueuedJob || normalizedPriority >= worstQueuedJob.priority) {
                return Promise.reject(queueFullError());
            }
            this.#cancelQueued(worstQueuedJob, queueFullError());
        }

        return new Promise((resolve, reject) => {
            const job = {
                priority: normalizedPriority,
                sequence: this.nextSequence,
                resolve,
                reject,
                signal,
                timeout: undefined,
                abortListener: undefined,
            };
            this.nextSequence += 1;
            if (timeoutMs !== undefined) {
                job.timeout = setTimeout(() => this.#cancelQueued(job, createAdmissionError(
                    `Semaphore admission timed out after ${timeoutMs}ms while queued.`,
                    'PRIORITY_SEMAPHORE_QUEUE_TIMEOUT',
                )), timeoutMs);
                job.timeout.unref?.();
            }
            if (signal) {
                job.abortListener = () => this.#cancelQueued(job, signal.reason || createAdmissionError(
                    'Semaphore admission was aborted while queued.',
                    'PRIORITY_SEMAPHORE_ABORTED',
                    'AbortError',
                ));
                signal.addEventListener('abort', job.abortListener, { once: true });
            }
            this.queue.push(job);
            this.#dispatch();
        });
    }

    async run(operation, options) {
        if (typeof operation !== 'function') {
            throw new TypeError('Semaphore operation must be a function.');
        }
        const release = await this.acquire(options);
        try {
            return await operation();
        }
        finally {
            release();
        }
    }

    #createRelease() {
        this.active += 1;
        let released = false;
        return () => {
            if (released) return false;
            released = true;
            this.active -= 1;
            this.#dispatch();
            return true;
        };
    }

    #cleanupQueued(job) {
        clearTimeout(job.timeout);
        if (job.signal && job.abortListener) {
            job.signal.removeEventListener('abort', job.abortListener);
        }
    }

    #cancelQueued(job, error) {
        const index = this.queue.indexOf(job);
        if (index < 0) return false;
        this.queue.splice(index, 1);
        this.#cleanupQueued(job);
        job.reject(error);
        this.#dispatch();
        return true;
    }

    #dispatch() {
        while (this.active < this.capacity && this.queue.length > 0) {
            this.queue.sort((left, right) => left.priority - right.priority || left.sequence - right.sequence);
            const job = this.queue.shift();
            this.#cleanupQueued(job);
            job.resolve(this.#createRelease());
        }
    }
}

function createPrioritySemaphore(options) {
    return new PrioritySemaphore(options);
}

module.exports = {
    DEFAULT_PRIORITY_SEMAPHORE_MAX_PENDING,
    PRIORITY_SEMAPHORE_PRIORITIES,
    createPrioritySemaphore,
};

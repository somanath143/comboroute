// MongoDB lean query results contain BSON ObjectIds on embedded subdocuments.
// Never structuredClone a lean document before writing embedded arrays back:
// that turns ObjectIds into plain objects which Mongoose rejects at cast time.
export function snapshotOrderForTransition(original) {
    return {
        status: original.status,
        failure_reason: original.failure_reason ?? null,
        legs: original.legs.map(({ restaurant_id, status, eta_minutes }) => ({ restaurant_id, status, eta_minutes })),
        events: original.events.map(({ status, message, timestamp }) => ({ status, message, timestamp }))
    };
}

// OrderModel disables Mongoose's __v version key. The explicit revision field
// enables compare-and-swap updates, while supporting legacy MongoDB orders.
export function orderRevisionConstraint(revision) {
    return revision == null ? { $exists: false } : revision;
}

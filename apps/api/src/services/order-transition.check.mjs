import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotOrderForTransition, orderRevisionConstraint } from './order-transition.js';

test('snapshots embedded docs without Mongo BSON _id fields', () => {
    const fakeBsonId = { buffer: Uint8Array.from([1, 2, 3]), _bsontype: 'ObjectId' };
    const old = {
        status: 'confirmed', failure_reason: null,
        legs: [{ _id: fakeBsonId, restaurant_id: 2, status: 'pending', eta_minutes: 10 }],
        events: [{ _id: fakeBsonId, status: 'confirmed', message: 'Ok', timestamp: '2026-10-23T00:00:00Z' }]
    };
    const snapshot = snapshotOrderForTransition(old);
    assert.deepEqual(snapshot.legs, [{ restaurant_id: 2, status: 'pending', eta_minutes: 10 }]);
    assert.deepEqual(snapshot.events, [{ status: 'confirmed', message: 'Ok', timestamp: '2026-10-23T00:00:00Z' }]);
    snapshot.legs[0].status = 'preparing';
    assert.equal(old.legs[0].status, 'pending');
});

test('revision constraint handles new and legacy order records', () => {
    assert.deepEqual(orderRevisionConstraint(undefined), { $exists: false });
    assert.deepEqual(orderRevisionConstraint(null), { $exists: false });
    assert.equal(orderRevisionConstraint(0), 0);
    assert.equal(orderRevisionConstraint(3), 3);
});

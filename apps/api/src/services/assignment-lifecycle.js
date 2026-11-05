import { AssignmentModel, PartnerModel } from '../models/operations.js';

export async function finishAssignment(orderId, session) {
  const assignment = await AssignmentModel.findOneAndUpdate({ order_id: orderId, status: { $in: ['active', 'picked_up'] } },
    { $set: { status: 'completed' } }, { new: true, session }).lean();
  if (assignment) await PartnerModel.updateOne({ user_id: assignment.partner_id, active_count: { $gt: 0 } }, { $inc: { active_count: -1 } }, { session });
}

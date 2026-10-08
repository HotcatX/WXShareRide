const { callTripManage } = require('./compat/rides')

function feedbackQuestion(role) {
  return role === 'driver' ? '预约的乘客都上车了吗？' : '您是否上车？'
}

function feedbackView(trip, outcome) {
  const confirmed = outcome.source === 'self_report'
  const canRate = outcome.outcome === 'yes' && trip._roleKind === 'passenger' && !!trip.driverUserId
  return { ...trip, _feedbackReady: true, _feedbackBusy: false, _feedbackError: '',
    _feedbackQuestion: feedbackQuestion(trip._roleKind),
    _feedbackOutcome: outcome.outcome, _feedbackAssumed: outcome.source === 'dismissed_default',
    _feedbackOccurredAt: outcome.occurredAt,
    _showRating: confirmed && canRate,
    _feedbackStatus: !confirmed ? '待确认' : canRate && !trip._myRating ? '待评分' : '已完成',
    _feedbackTone: !confirmed ? 'pending' : canRate && !trip._myRating ? 'rating' : 'done' }
}

async function rateDriver(trip, score, call = callTripManage) {
  if (!trip || trip._roleKind !== 'passenger' || !trip._showRating || trip._myRating || !trip.driverUserId ||
    !['carpool', 'request'].includes(trip._sourceType) || !Number.isInteger(score) || score < 1 || score > 5) {
    throw Error('INVALID_RATING')
  }
  const result = await call({ action: 'rateUser', type: trip._sourceType, tripId: trip._id,
    targetUserId: trip.driverUserId, targetRole: 'driver', score })
  // A retry can recover an earlier accepted score; render its receipt.
  if (!result?.ok || result.data?.rideId !== trip._id || result.data?.targetId !== trip.driverUserId ||
    !Number.isInteger(result.data?.score) || result.data.score < 1 || result.data.score > 5) throw Error('INVALID_RESPONSE')
  return result.data.score
}

function ratingError(error) {
  return error?.code === 'ALREADY_RATED' ? '您已评价，请刷新查看' : '评价暂未保存，请重试'
}

module.exports = { feedbackQuestion, feedbackView, rateDriver, ratingError }

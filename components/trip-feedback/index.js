Component({
  options: { styleIsolation: 'isolated' },
  properties: {
    trip: { type: Object, value: null }
  },
  data: {
    stars: [1, 2, 3, 4, 5]
  },
  methods: {
    stopCardTap() {},
    onAnswer(event) {
      const trip = this.properties.trip
      const outcome = event && event.currentTarget && event.currentTarget.dataset.outcome
      if (!trip || !trip._id || trip._feedbackBusy || !trip._feedbackReady) return
      if (trip._feedbackOutcome && !trip._feedbackAssumed) return
      if (outcome !== 'yes' && outcome !== 'no') return
      this.triggerEvent('answer', { id: trip._id, outcome })
    },
    onRate(event) {
      const trip = this.properties.trip
      const score = Number(event && event.currentTarget && event.currentTarget.dataset.score)
      if (!trip || !trip._id || trip._feedbackBusy || !trip._feedbackReady) return
      if (!trip._showRating || trip._feedbackOutcome !== 'yes' || trip._feedbackAssumed || trip._myRating > 0) return
      if (!Number.isInteger(score) || score < 1 || score > 5) return
      this.triggerEvent('rate', { id: trip._id, score })
    },
    onRetry() {
      const trip = this.properties.trip
      if (!trip || !trip._feedbackError || trip._feedbackReady || trip._feedbackBusy) return
      this.triggerEvent('retry', { id: trip._id })
    }
  }
})

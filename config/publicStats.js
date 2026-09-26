// Bundled rollout configuration for the public statistics read only.
// Changing this file takes effect after distributing a new mini-program build;
// it is not a remote switch and does not enable analytics data collection.
module.exports = Object.freeze({
  enabled: true,
  rolloutPercent: Object.freeze({ develop: 100, trial: 100, release: 100 })
})

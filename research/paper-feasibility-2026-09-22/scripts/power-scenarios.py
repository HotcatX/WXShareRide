"""Illustrative planning only: independent Bernoulli outcomes, no actual efficacy estimate.

The clustering multiplier is a sensitivity approximation, not a replacement for
randomization-based power simulation with the eventual assignment design.
"""
import json
import math
from statistics import NormalDist


def per_arm(p0, p1, alpha=0.05, power=0.8):
    za = NormalDist().inv_cdf(1 - alpha / 2)
    zb = NormalDist().inv_cdf(power)
    pm = (p0 + p1) / 2
    return math.ceil((za * math.sqrt(2 * pm * (1 - pm)) +
                      zb * math.sqrt(p0 * (1 - p0) + p1 * (1 - p1))) ** 2 /
                     (p1 - p0) ** 2)


scenarios = []
for delta in [0.05, 0.10, 0.15]:
    n = per_arm(0.4, 0.4 + delta)
    for mean_cluster, icc in [(1, 0), (10, 0.05), (20, 0.10)]:
        de = 1 + (mean_cluster - 1) * icc
        total = 2 * math.ceil(n * de)
        scenarios.append({
            "assumed_control_probability": 0.4,
            "absolute_effect_percentage_points": delta * 100,
            "independent_observations_per_arm": n,
            "assumed_mean_cluster_size": mean_cluster,
            "assumed_intracluster_correlation": icc,
            "approximate_design_effect": de,
            "approximate_total_observations": total,
            "calendar_days_at_assumed_10_eligible_intents_daily": math.ceil(total / 10),
            "calendar_days_at_assumed_30_eligible_intents_daily": math.ceil(total / 30),
        })

print(json.dumps({
    "type": "hypothetical_power_sensitivity_not_empirical_evidence",
    "alpha_two_sided": 0.05,
    "power": 0.8,
    "assumptions": [
        "Control probability 0.4 is hypothetical, not estimated from surviving trip records.",
        "10 and 30 unique eligible intents per day are illustrative, not observed traffic.",
        "Exposure clicks, posted offers, seats, memberships and users are not interchangeable denominators.",
        "Actual cluster power depends on number of randomized clusters, unequal size, time trends, serial correlation, interference, and user recurrence.",
        "Missing or disputed actual-travel outcomes cannot simply be coded as failures or handled by inflating n alone.",
        "Reachability dilutes ITT effects: at 50% reach, a 10-point effect among reached users may yield a 5-point ITT effect only under strong assumptions.",
        "Final sample size requires pilot-estimated parameters and simulation of the predeclared randomization and estimator."
    ],
    "scenarios": scenarios
}, indent=2))

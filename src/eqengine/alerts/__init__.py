"""
eqengine.alerts — Alert dispatch and cooldown management.

Sends event notifications to the dashboard via HTTP POST and enforces
rate-limiting to prevent alert floods during swarm sequences.
"""

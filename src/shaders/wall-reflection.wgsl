// Linear Bouzidi/Firdaouss/Lallemand interpolation for a stationary wall.
// q is the fraction of the lattice link from the fluid centre to the wall.
// Both the flow and force passes use exactly this returned population.
fn reflected(outgoing: f32, incoming: f32, away: f32, q: f32) -> f32 {
  if (q < 0.5) { return 2.0*q*outgoing+(1.0-2.0*q)*away; }
  return (outgoing+(2.0*q-1.0)*incoming)/(2.0*q);
}

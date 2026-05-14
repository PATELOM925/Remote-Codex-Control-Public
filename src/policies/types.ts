export interface PolicyDecision {
  allowed: boolean;
  reason: string;
  policyId: string;
}

export interface Policy<TContext> {
  readonly id: string;
  evaluate(context: TContext): PolicyDecision;
}

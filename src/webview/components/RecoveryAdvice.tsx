import { classifyRecovery } from "../../shared/recovery";
export function RecoveryAdvice(props: { error: string; onRetry?: () => void }) {
  const advice = () => classifyRecovery(props.error);
  return <section class={`recovery-advice recovery-advice--${advice().kind}`} aria-label="Recovery guidance">
    <strong>{advice().title}</strong><p>{advice().explanation}</p>
    <code>{props.error}</code>
    {advice().retryable && props.onRetry ? <button type="button" onClick={props.onRetry}>Retry request</button> : null}
  </section>;
}

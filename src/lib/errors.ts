/**
 * 에러를 사람이 읽을 수 있게 만든다.
 *
 * `err.message` 만 찍으면 **AggregateError 는 빈 문자열을 낸다** — pg 의 ECONNREFUSED 가
 * 그렇다. 실제로 DB 가 꺼진 상태에서 eval 이 **아무 메시지도 없이 exit 1** 로 끝났고,
 * 원인을 찾는 데 시간이 걸렸다. 조용한 실패를 만들지 않는 것이 이 레포의 규칙인데
 * 에러 핸들러 자체가 그 규칙을 어기고 있었다.
 */
export function formatError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);

  const parts: string[] = [err.stack || err.message || err.name];

  // AggregateError 의 개별 원인은 stack 에 들어가지 않는다. 이게 없으면
  // "연결이 거부됨"인지 "호스트를 못 찾음"인지도 구분할 수 없다.
  const inner = (err as { errors?: unknown[] }).errors;
  if (Array.isArray(inner)) {
    for (const e of inner) {
      parts.push(`  cause: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // pg 는 진단에 필요한 코드를 message 밖에 담는다.
  const code = (err as { code?: string }).code;
  if (code) parts.push(`  code: ${code}`);

  return parts.join("\n");
}

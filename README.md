# nemokoala-mods

Claude Code 모드 모음 (CLI · 데스크톱 앱 Code 탭 공용)

| 플러그인 | 설명 |
|---|---|
| `usage-band` | 입력창 위에 5시간 / 주간 / Fable 주간 사용량 게이지 표시 (claude.ai Pro·Max 로그인 필요) |
| `git-graph` | 접었다 펼 수 있는 깃 커밋 그래프 패널. 기본은 접힌 상태로 열리고 ▸ (`c`) 또는 `/git-graph`로 펼침. 레인(브랜치)이 많으면 그래프 폭을 제한하고 ◀ ▶ (`h` `l`)로 좌우 이동. `/git-graph [저장소 경로]` |
| `pretty-replies` | 답변 왼쪽에 세로 테두리와 여백을 그림. 답변의 첫 블록은 주황(Claude 색), 도구 호출 뒤 이어지는 블록은 흐린 색. `/pretty [on\|off]`로 켜고 끔(인자 없으면 토글, 설정은 유지) |

## 설치

Claude Code에서:

```
/plugin marketplace add nemokoala/claude-mods
/plugin install usage-band@nemokoala-mods
/plugin install git-graph@nemokoala-mods
/plugin install pretty-replies@nemokoala-mods
```

또는 터미널에서:

```bash
claude plugin marketplace add nemokoala/claude-mods
claude plugin install usage-band@nemokoala-mods
claude plugin install git-graph@nemokoala-mods
claude plugin install pretty-replies@nemokoala-mods
```

설치 후 새 세션부터 적용됩니다.

---
aside: false
---

# OpenAPI 레퍼런스

`services/api/openapi.yaml`에서 빌드할 때 생성합니다. 인증 방식, 요청·응답 스키마, 오류 코드가 모두 들어 있어요.

<p><a class="dio-open-redoc" href="/service/openapi.html" target="_blank" rel="noopener">전체 화면으로 열기 ↗</a></p>

## 엔드포인트

<!--@include: ./_endpoints.md-->

인증 열의 `bearerAuth`는 `Authorization: Bearer <key>`, `queryKey`는 `?key=<key>`입니다.

## 상세 스키마

<iframe class="dio-redoc" src="/service/openapi.html" title="Diorama API OpenAPI reference" loading="lazy"></iframe>

<style>
.dio-redoc { width: 100%; height: 80vh; min-height: 640px; border: 1px solid var(--vp-c-divider); border-radius: 12px; background: #fff; }
.dio-open-redoc { font-weight: 600; }
</style>

Cloudwiki/위키 문법 가이드

# Cloudwiki 문법 가이드

Cloudwiki에서 지원하는 기본 마크다운 문법과 확장 문법(위키 고유 문법)에 대한 안내입니다.
Cloudwiki 문법은 기존 일반 마크다운 문법과 호환되며, 일반 마크다운 문법으로 작성된 문서를 그대로 사용할 수 있습니다.


---

# 기본 마크다운 문법

## 텍스트 꾸미기

**굵게**
```
**굵게**
```

*기울임*
```
*기울임* 혹은 _기울임_
```

***굵게 + 기울임***
```
***굵게 + 기울임***
```

~~취소선~~
```
~~취소선~~
```

==형광펜 강조==
```
==형광펜 강조==
```

__밑줄__
```
__밑줄__
```

||스포일러|| [* 표 문법 내부에서는 사용할 수 없습니다.]
```
||스포일러||
```

> 여러 스타일을 조합할 수 있습니다. 예: **굵게 _기울임_**, ~~***굵고 기울인 취소선***~~

---

## 제목 (Headings)

제목은 `#` 기호의 개수로 단계를 구분합니다. `#`부터 `######`까지 6단계를 지원합니다.

```
# 제목 1단계
## 제목 2단계
### 제목 3단계
#### 제목 4단계
##### 제목 5단계
###### 제목 6단계
```

> `#` 뒤에 반드시 공백을 한 칸 넣어야 제목으로 인식됩니다.

---

## 목록 (List)

### 순서 없는 목록
`-`, `*`, `+` 중 하나를 사용합니다. 들여쓰기(스페이스 2칸 또는 탭)로 하위 항목을 만들 수 있습니다.

- 항목 1
- 항목 2
  - 하위 항목 2-1
  - 하위 항목 2-2
    - 하위 항목 2-2-1

```
- 항목 1
- 항목 2
  - 하위 항목 2-1
  - 하위 항목 2-2
    - 하위 항목 2-2-1
```

### 순서 있는 목록
숫자와 마침표(`.`)를 사용합니다. 실제 입력한 숫자와 관계없이 순서대로 자동 번호가 매겨집니다.

1. 첫 번째
2. 두 번째
3. 세 번째
   1. 하위 항목

```
1. 첫 번째
2. 두 번째
3. 세 번째
   1. 하위 항목
```

### 체크리스트
- [ ] 미완료 항목
- [x] 완료 항목

```
- [ ] 미완료 항목
- [x] 완료 항목
```

---

## 링크

기본적으로 링크 및 이메일은 별도 문법 없이 붙여넣을 수 있습니다.

링크의 표시 텍스트를 설정할 수 있습니다.

[일반 링크](https://vialinks.xyz)
```
[일반 링크](https://vialinks.xyz)
```



URL을 그대로 링크로 표시하려면 꺾쇠괄호로 감쌉니다.

<https://vialinks.xyz>
```
<https://vialinks.xyz>
```


## 이미지

![Cloudwiki-로고.jpg](https://wiki.vialinks.xyz/media/images/Cloudwiki-로고.jpg)

```
![Cloudwiki-로고.jpg](https://wiki.vialinks.xyz/media/images/Cloudwiki-로고.jpg)
```
이미지의 경우, 문서 편집기의 이미지 업로드 기능 사용 시 자동으로 작성됩니다.

### (확장) 이미지 사이즈 지정

이미지 링크 뒤에 `{size:옵션}`을 붙여 이미지 사이즈를 조절할 수 있습니다.
지원되는 사이즈 옵션: `icon`, `small`, `medium`, `full` (기본값)
`icon` 설정 사용 시 이미지를 그대로 텍스트 줄 안에서 사용할 수 있습니다. 

[+ 사이즈별 이미지 보기]
![Cloudwiki-로고.jpg](https://wiki.vialinks.xyz/media/images/Cloudwiki-로고.jpg){size:icon}
![Cloudwiki-로고.jpg](https://wiki.vialinks.xyz/media/images/Cloudwiki-로고.jpg){size:small}
![Cloudwiki-로고.jpg](https://wiki.vialinks.xyz/media/images/Cloudwiki-로고.jpg){size:medium}
![Cloudwiki-로고.jpg](https://wiki.vialinks.xyz/media/images/Cloudwiki-로고.jpg){size:full}
[-]


```
![Cloudwiki-로고.jpg](https://wiki.vialinks.xyz/media/images/Cloudwiki-로고.jpg){size:icon}
![Cloudwiki-로고.jpg](https://wiki.vialinks.xyz/media/images/Cloudwiki-로고.jpg){size:small}
![Cloudwiki-로고.jpg](https://wiki.vialinks.xyz/media/images/Cloudwiki-로고.jpg){size:medium}
![Cloudwiki-로고.jpg](https://wiki.vialinks.xyz/media/images/Cloudwiki-로고.jpg){size:full}
```
문서 편집기에서 이미지를 첨부할 때 나타나는 사이즈 지정 옵션, 또는 이미지 문법에 커서를 가져다 놓을 때 나타나는 팝업을 통해 쉽게 옵션을 적용할 수 있습니다.

---

## 표

Cloudwiki 문법은 기본 마크다운 표 문법과 호환되며, 셀 병합, 색상 지정을 추가로 지원합니다.

### 기본 표

| 열 1 | 열 2 | 열 3 |
| --- | --- | --- |
| 내용 A | 내용 B | 내용 C |

```
| 열 1 | 열 2 | 열 3 |
| --- | --- | --- |
| 내용 A | 내용 B | 내용 C |
```

> {mdi:alert} `||스포일러||` 문법을 표 내부에 사용할 수 없습니다.

### 열 정렬

콜론(`:`)의 위치로 열의 정렬 방식을 지정할 수 있습니다.

| 왼쪽 정렬 | 가운데 정렬 | 오른쪽 정렬 |
| :--- | :---: | ---: |
| 내용 | 내용 | 내용 |

```
| 왼쪽 정렬 | 가운데 정렬 | 오른쪽 정렬 |
| :--- | :---: | ---: |
| 내용 | 내용 | 내용 |
```

### (확장) 셀 병합
셀의 좌우, 상하 병합을 지원합니다.
`{<}` `{>}` 문자를 통해 좌우 셀과 병합, `{^}` 문자를 통해 위 셀과 병합할 수 있습니다.
색상 문법은 병합 문법이 아닌 일반 내용 칸에 작성해야 합니다.

| 세로 병합 | {>} | 가로 병합 | 내용 |
| --- | --- | --- | --- |
| {^} | 내용 | {<} | 세로 병합 |
| 내용| 내용 | 내용 | {^} |

```
| 세로 병합 | {>} | 가로 병합 | 내용 |
| --- | --- | --- | --- |
| {^} | 내용 | {<} | 세로 병합 |
| 내용| 내용 | 내용 | {^} |
```

### (확장) 셀 가운데 병합

셀 병합 시 가운데로 모으고 싶은 경우, 병합할 가운데 셀에 `{><}`를 입력합니다.

| 내용 | {><} | 내용 |
| --- | --- | --- |
| 내용 | 내용 | 내용 |



```
| 내용 | {><} | 내용 |
| --- | --- | --- |
| 내용 | 내용 | 내용 |
```

---

## 확장 문법 컬러 코드

Cloudwiki는 표 셀, 펼치기/접기 제목 등에서 배경색과 글자색을 지정할 수 있는 확장 문법을 제공합니다.
색상 값은 CSS 컬러 표기(`#ff0000`, `rgb(...)`, `red` 등)가 모두 가능합니다.

### `{bg:색상}` / `{color:색상}`

배경색은 `{bg:색상}`, 글자색은 `{color:색상}` 문법으로 지정합니다.

| 기본 셀 | {bg:#ff0000} 빨간 배경 | {bg:#000} {color:#fff} 검정 배경 흰 글씨 |
| --- | --- | --- |
| 내용 | {bg: yellow} 노란 배경 | {color: blue} 파란 글씨 |

```
| 기본 셀 | {bg:#ff0000} 빨간 배경 | {bg:#000} {color:#fff} 검정 배경 흰 글씨 |
| --- | --- | --- |
| 내용 | {bg: yellow} 노란 배경 | {color: blue} 파란 글씨 |
```

> {mdi:alert} 배경과 글씨 색상을 모두 설정하는 것을 권장합니다. 둘 중 하나만 설정하는 경우, 다크 모드에서 가독성 문제가 생길 가능성이 높습니다.

### `{palette:이름}` — 컬러 팔레트

자주 쓰는 배경/글씨 조합을 미리 정의해두고 한 번에 적용하는 문법입니다.
`{palette:이름}` 토큰은 내부적으로 해당 팔레트의 `{bg:...}{color:...}` 로 치환되므로 `{bg:}`/`{color:}` 가 동작하는 모든 위치 (표 셀, 펼치기 제목 등) 에서 그대로 사용할 수 있습니다.

#### 기본 프리셋

별도 설정 없이 바로 쓸 수 있는 의미 기반 프리셋입니다. 부트스트랩 컬러 스키마를 따르며 다크 모드에도 자동으로 대응합니다.

| 이름 | 용도 |
| --- | --- |
| `primary` | 주요 강조 |
| `secondary` | 보조 |
| `success` | 성공 / 완료 |
| `info` | 정보 |
| `warning` | 경고 |
| `danger` | 위험 / 오류 |
| `muted` | 비활성 / 부가 |

| {palette:primary} primary | {palette:success} success | {palette:warning} warning | {palette:danger} danger |
| --- | --- | --- | --- |
| {palette:secondary} secondary | {palette:info} info | {palette:muted} muted | 기본 셀 |

```
| {palette:primary} primary | {palette:success} success | {palette:warning} warning | {palette:danger} danger |
| --- | --- | --- | --- |
| {palette:secondary} secondary | {palette:info} info | {palette:muted} muted | 기본 셀 |
```

#### 커스텀 프리셋

`wrangler.toml` 의 `PALETTES` 환경변수에 JSON 으로 팔레트를 정의하면 기본 프리셋과 동일한 방식으로 사용할 수 있습니다.

```json
{
  "cloudflare": { "bg": "#FF8000", "color": "#000000" },
  "anthropic":  { "bg": "#F0EEE6", "color": "#C15F3C" }
}
```

라이트/다크 모드에 따라 다른 색을 쓰고 싶다면 `light`/`dark` 를 분리하여 지정합니다.

```json
{
  "cloudflare": {
    "light": { "bg": "#FF8000", "color": "#000000" },
    "dark":  { "bg": "#CC6600", "color": "#FFFFFF" }
  }
}
```

이름이 기본 프리셋과 충돌하면 커스텀 팔레트가 우선 적용됩니다.

#### 오버라이드

팔레트 뒤에 `{bg:...}` 또는 `{color:...}` 를 연달아 쓰면, 뒤에 오는 값이 팔레트의 해당 속성을 덮어씁니다.

```
{palette:cloudflare}{color:#ffffff}  → 배경은 팔레트, 글씨색만 흰색으로 강제
```

정의되지 않은 이름을 참조하면 렌더 시 토큰이 조용히 무시되며, 에디터에서는 자동완성 목록에 나타나지 않습니다.

---

## 수평선 (Horizontal Rule)

섹션을 구분할 때 사용합니다. `-`, `*`, `_` 중 하나를 3개 이상 연속으로 입력합니다.

---

```
---
***
___
```

## 인용구 및 코드 블록

> 인용문 예시입니다.
>> 중첩 인용문입니다.
```
> 인용문 예시입니다.
>> 중첩 인용문입니다.
```

`인라인 코드`
```
`인라인 코드`
```

```javascript
// 여러 줄 코드 블록
console.log("Test");
```
- 코드 블록을 작성하려면 백틱(`) 3개를 연달아 씁니다.
- 여러 줄 코드 블록을 시작하는 백틱 뒤에 프로그래밍 언어명을 지정하면, 해당 언어 문법에 맞는 하이라이트 처리가 작동합니다.
- 코드 블록 내부에 들어간 모든 내용은 위키 문법으로 작동하지 않습니다.


---

# 위키 확장 문법

## 위키 링크(내부 링크)

위키 내의 다른 문서로 이동할 수 있는 링크를 편리하게 생성합니다.
`|` 파이프 기호를 이용해 링크와 표시 텍스트를 변경하거나, `#목차번호` 기호를 이용해 문서의 특정 문단을 지정할 수 있습니다. 

[[문서제목]]
[[문서제목|표시텍스트]]
```
[[문서제목]]
[[문서제목|표시텍스트]]
```

[[문서제목#목차번호]] 형식으로 작성하면, 해당 링크를 클릭시 문서의 특정 목차로 이동됩니다.
`[[문서제목#1.1|표시 텍스트]]` 형식으로 표시 텍스트 문법과 함께 사용 가능합니다.


---

## 틀 (Transclusion)

다른 문서(틀)의 내용을 현재 문서에 포함시킬 때 사용합니다.
자세한 내용은 [[Cloudwiki/기능/틀]] 문서를 참고하세요.

---

테스트 틀입니다

```
틀 내부 코드블럭 테스트
```

테스트용 틀 끝

---


```
{{테스트}}
```

---

### 위키 링크, 틀 자동완성

문서 편집기에서 `{{`, `[[`를 입력하면 자동으로 사용 가능한 틀/위키 링크 문서를 검색 후, 클릭이나 키보드 방향키+엔터로 선택 가능한 자동완성 메뉴가 표시됩니다.



---

## 아이콘 삽입

CloudWiki는 부트스트랩 아이콘(Bootstrap Icons)과 MDI(Material Design Icons)를 지원합니다.

### 기본 문법

{bi:card-text}
```
{bi:card-text}
```

{mdi:dots-vertical}
```
{mdi:dots-vertical}
```


- 아이콘 목록은 아래 링크에서 확인할 수 있습니다.
> {mdi:bootstrap} [Bootstrap Icons](https://icons.getbootstrap.kr)
> {mdi:vector-square} [Material Design Icons](https://pictogrammers.com/library/mdi)

**{mdi:alert} MDI에 포함된 기업 로고들이 다수 제거될 예정입니다. 기업 로고 삽입은 부트스트랩 아이콘 또는 이미지 삽입의 `{size:icon}` 파라미터 이용을 권장합니다.**

---

### 아이콘 자동완성

문서 편집기에서 `{mdi:`, `{bi:`를 입력하면 사용 가능한 아이콘 목록을 보여주는 메뉴가 표시되며, 클릭 또는 키보드 방향키 + 엔터로 자동완성이 가능합니다.


---

## 각주

문서 내에 부연 설명을 추가할 때 사용합니다.

부연 설명을 추가할 텍스트[* 여기에 각주 내용이 들어갑니다]
```
부연 설명을 추가할 텍스트[* 여기에 각주 내용이 들어갑니다]
```



---

## 펼치기/접기

문서 내에 내용을 숨겨두고 클릭하여 펼칠 수 있는 블록을 생성합니다.
제목에 지정한 `{bg:색상}`, `{color:색상}`, `{palette:이름}` 옵션으로 배경과 글씨 색상을 꾸밀 수 있습니다.

[+ 상세 내용 보기 (클릭)]
여기에 숨겨진 내용이 들어갑니다.
**마크다운** 문법도 이 안에서 정상 동작합니다.
[-]
```
[+ 상세 내용 보기 (클릭)]
여기에 숨겨진 내용이 들어갑니다.
**마크다운** 문법도 이 안에서 정상 동작합니다.
[-]
```

[+ {bg:#f8f9fa} {color:blue} 커스텀 색상]
배경색과 글자색이 지정된 상태입니다.
[-]

```
[+ {bg:#f8f9fa} {color:blue} 커스텀 색상]
배경색과 글자색이 지정된 상태입니다.
[-]
```




---

## 타임스탬프

`{타임스탬프종류:시간}` 을 입력하면 타임스탬프로 변환됩니다.

지원하는 타임스탬프 종류 
- 디데이`dday`
지정한 날짜로부터 남은 날짜, 또는 지난 날짜수를 표시합니다. 당일의 경우 D-Day로 표시됩니다.
시간은 YYYY-MM-DD 형식 또는 MM-DD 형식으로 작성합니다.
- 나이
생년월일 입력으로 만 나이를 표시합니다.
시간은 YYYY-MM-DD 형식으로 작성합니다.
- 시간`time`
특정 시간을 고정해 표시합니다.
시간은 유닉스 시간 정수로 작성합니다.
- 타이머`timer` 
특정 시간으로부터 남은 시간 또는 지난 시간을 표시합니다.
시간은 유닉스 시간 정수로 작성합니다.

{dday:2026-03-09}
{dday:03-09}
{age:2007-08-31}
{time:1775394426}
{timer:1777987135}

```
{dday:2026-03-09}
{dday:03-09}
{age:2007-08-31}
{time:1775394426}
{timer:1777987135}

```

---

## 미디어 삽입


다양한 미디어 플랫폼의 콘텐츠를 링크 붙여넣기만으로 삽입할 수 있습니다.

**지원 서비스 목록**
- {bi:youtube} YouTube
- {mdi:video} ニコニコ動画
- {bi:spotify} Spotify

https://youtu.be/jQmYZWjLwzw

```
https://youtu.be/jQmYZWjLwzw
```

https://nicovideo.jp/watch/sm2937784

```
https://nicovideo.jp/watch/sm2937784
```

https://open.spotify.com/track/1k5F2EwzptN821wy7cPggG?si=9494bd33a24642cd

```
https://open.spotify.com/track/1k5F2EwzptN821wy7cPggG?si=9494bd33a24642cd
```

링크를 임베딩 없이 첨부하고 싶다면 마크다운 문법을 사용하실 수 있습니다.
<https://youtu.be/jQmYZWjLwzw>
[https://youtu.be/jQmYZWjLwzw](https://youtu.be/jQmYZWjLwzw)
[유튜브 링크](https://youtu.be/jQmYZWjLwzw)

```
<https://youtu.be/jQmYZWjLwzw>
[https://youtu.be/jQmYZWjLwzw](https://youtu.be/jQmYZWjLwzw)
[유튜브 링크](https://youtu.be/jQmYZWjLwzw)
```



불필요한 영상 뷰어 표시를 막기 위해 같은 줄에 다른 텍스트가 섞인 경우, 뷰어가 로드되지 않습니다.

테스트 https://youtu.be/jQmYZWjLwzw

예외적으로 `> 인용문`에는 임베딩을 사용할 수 있습니다.

> https://youtu.be/jQmYZWjLwzw

## 지도 삽입

구글 지도 임베드 링크를 붙여넣으면 지도가 삽입됩니다.

https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d380514.6269296274!2d-88.06153207605908!3d41.833239273665306!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x880e2c3cd0f4cbed%3A0xafe0a6ad09c0c000!2z66-46rWtIOydvOumrOuFuOydtCDsi5zsubTqs6A!5e0!3m2!1sko!2skr!4v1776126803127!5m2!1sko!2skr

```
https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d380514.6269296274!2d-88.06153207605908!3d41.833239273665306!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x880e2c3cd0f4cbed%3A0xafe0a6ad09c0c000!2z66-46rWtIOydvOumrOuFuOydtCDsi5zsubTqs6A!5e0!3m2!1sko!2skr!4v1776126803127!5m2!1sko!2skr
```


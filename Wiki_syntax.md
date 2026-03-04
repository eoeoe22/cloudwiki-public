⚠️ 위키 자체 문법이 포함되어 있습니다.
https://wiki.vialinks.xyz/wiki/%EC%9C%84%ED%82%A4%20%EB%AC%B8%EB%B2%95%20%EA%B0%80%EC%9D%B4%EB%93%9C
에서 열람하시는것을 추천합니다.


# CloudWiki 문법 가이드

CloudWiki에서 지원하는 기본 마크다운 문법과 확장 문법(위키 고유 문법)에 대한 안내입니다.
각 항목은 [실제 렌더링 형태]와 [작성 코드]로 나뉘어 있습니다.

---

## 1. 텍스트 꾸미기

**굵게**
```markdown
**굵게**
```

*기울임*
```markdown
*기울임* 혹은 _기울임_
```

~~취소선~~
```markdown
~~취소선~~
```

---

## 2. 링크 및 이미지

[일반 링크](https://github.com)
```markdown
[일반 링크](https://github.com)
```


```markdown
![대체 텍스트](이미지주소 "타이틀")
```

---

## 3. 표 (Table) 및 셀 색상 지정

CloudWiki는 기본적인 마크다운 표뿐만 아니라 표의 각 셀 배경색상 및 텍스트 색상을 개별적으로 지정할 수 있는 기능을 지원합니다.
문법은 셀 내용의 첫 부분에 `{bg:색상코드}` 또는 `{color:색상코드}`를 붙이는 방식입니다.

| 기본 셀 | {bg:#ffcccc} 빨간 배경 | {bg:#000} {color:#fff} 검정 배경 흰 글씨 |
| --- | --- | --- |
| 내용 | {bg: yellow} 노란 배경 | {color: blue} 파란 글씨 |

```markdown
| 기본 셀 | {bg:#ffcccc} 빨간 배경 | {bg:#000} {color:#fff} 검정 배경 흰 글씨 |
| --- | --- | --- |
| 내용 | {bg: yellow} 노란 배경 | {color: blue} 파란 글씨 |
```

---

## 4. 확장 문법: 위키 링크(내부 링크)

위키 내의 다른 문서로 이동할 수 있는 링크를 편리하게 생성합니다.

[[문서제목]]
```markdown
[[문서제목]]
```

---

## 5. 확장 문법: 틀 (Transclusion)

다른 문서(틀)의 내용을 현재 문서에 포함시킬 때 사용합니다.

{{테스트}}
```
{{테스트}}
```

---

## 6. 확장 문법: 아이콘 삽입

CloudWiki는 부트스트랩 아이콘(Bootstrap Icons)과 MDI(Material Design Icons)를 지원합니다.

{bi:card-text}
```markdown
{bi:card-text}
```

{mdi:dots-vertical}
```markdown
{mdi:dots-vertical}
```
*(주의: 아이콘 코드는 공식 가이드 문서의 아이콘 이름을 그대로 사용합니다)*

- 아이콘 목록은 아래 링크에서 확인할 수 있습니다.
> {mdi:bootstrap} [Bootstrap Icons](https://icons.getbootstrap.kr)
> {mdi:vector-square} [Matarial Design Icons](https://pictogrammers.com/library/mdi)

---

## 7. 확장 문법: 각주 (Footnote)

문서 내에 부연 설명을 추가할 때 사용합니다.

부연설명을 추가할 텍스트[* 여기에 각주 내용이 들어갑니다]
```markdown
부연설명을 추가할 텍스트[* 여기에 각주 내용이 들어갑니다]
```

---

## 8. 인용구 및 코드블럭

> 인용문 예시입니다.
>> 중첩 인용문입니다.
```markdown
> 인용문 예시입니다.
>> 중첩 인용문입니다.
```

`인라인 코드`
```markdown
`인라인 코드`
```

```javascript
// 여러 줄 코드블럭
console.log("Hello Wiki!");
```
※ 코드블럭을 작성하려면 백틱(`) 3개를 연달아 씁니다.

---

## 9. 확장 문법: 펼치기/접기 (Folding Block)

문서 내에 내용을 숨겨두고 클릭하여 펼칠 수 있는 블록을 생성합니다.
제목에 지정한 `{bg:색상}` 및 `{color:색상}` 옵션으로 배경과 글씨 색상을 꾸밀 수 있습니다.

[+ 상세 내용 보기 (클릭)]
여기에 숨겨진 내용이 들어갑니다.
**마크다운** 문법도 이 안에서 정상 동작합니다.
[-]
```markdown
[+ 상세 내용 보기 (클릭)]
여기에 숨겨진 내용이 들어갑니다.
**마크다운** 문법도 이 안에서 정상 동작합니다.
[-]
```

[+ {bg:#f8f9fa} {color:blue} 커스텀 색상 접기]
배경색과 글자색이 지정된 상태입니다.
[-]
```markdown
[+ {bg:#f8f9fa} {color:blue} 커스텀 색상 접기]
배경색과 글자색이 지정된 상태입니다.
[-]
```

---

## 유튜브/니코니코 동화 임베드

유튜브, 니코니코동화 동영상 임베드를 지원합니다.
별도의 문법 없이 유튜브 / 니코니코동화 링크를 단순 삽입시 자동으로 임베드 뷰어로 변환됩니다.


https://youtu.be/jQmYZWjLwzw

```
https://youtu.be/jQmYZWjLwzw
```

https://nicovideo.jp/watch/sm2937784

```
https://nicovideo.jp/watch/sm2937784
```

링크를 그대로 첨부하고 싶다면 마크다운 문법을 사용하실수 있습니다.
[https://youtu.be/jQmYZWjLwzw](https://youtu.be/jQmYZWjLwzw)
[유튜브링크](https://youtu.be/jQmYZWjLwzw)

```
[](https://youtu.be/jQmYZWjLwzw)
[https://youtu.be/jQmYZWjLwzw](유튜브링크)
```

펼치기/접기 박스 내부에도 임베드 뷰어를 사용할수 있습니다.

[+ 테스트]
https://youtu.be/jQmYZWjLwzw
[-]

```
[+ 테스트]
https://youtu.be/jQmYZWjLwzw
[-]
```

불필요한 영상 뷰어 표시를 막기 위해 같은 줄에 일반 텍스트가 섞인 경우, 뷰어가 로드되지 않습니다.

테스트 https://youtu.be/jQmYZWjLwzw
https://youtu.be/jQmYZWjLwzw 테스트

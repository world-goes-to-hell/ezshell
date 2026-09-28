# framer-motion 의 motion.* 요소는 onDragStart / onDragEnd 를 DOM 에 전달하지 않는다

## 증상
`<motion.div draggable onDragStart={...} onDragEnd={...}>` 로 HTML5 드래그 앤 드롭을 구현하면
드래그 고스트 이미지는 뜨지만 핸들러가 전혀 호출되지 않는다. 에러도 없다.
타입 검사에서는 TS2345 / TS2322 (`MouseEvent | PointerEvent | TouchEvent` 를 `DragEvent` 에 할당 불가) 로만 드러난다.

## 원인
framer-motion 은 `onDragStart`, `onDrag`, `onDragEnd` 를 자체 드래그 제스처 prop 으로 예약한다
(`node_modules/framer-motion/dist/es/motion/utils/valid-prop.mjs`).
이 prop 들은 DOM 으로 전달되지 않고, `drag` prop 을 켰을 때 framer 의 포인터 기반 드래그에서만 호출된다.
`draggable` 은 예외 처리되어 DOM 에 그대로 전달되기 때문에, "드래그는 되는데 이벤트가 안 온다" 는 상태가 된다.

## 판별
- 같은 핸들러를 일반 `div` 에 달면 동작하고, `motion.div` 에서만 안 되면 이 문제다.
- `tsc` 에서 드래그 핸들러 이벤트 타입 불일치가 나면 거의 확실하다.

## 해결
- `onDragStartCapture` / `onDragEndCapture` 사용 (framer 가 가로채지 않는 React 표준 prop)
- 또는 드래그 대상을 motion 요소 안쪽의 일반 요소로 분리
- `onDragOver`, `onDrop`, `onDragLeave` 는 예약 목록에 없어 그대로 동작한다

## 사례
2026-09-28 my-ssh-client: 메인 탭 드래그(분할/팝아웃)와 세션 → 폴더 드래그가 이 문제로 동작하지 않았다.
상세: docs/fix/2026-09-28-bugs-found-by-typecheck.md

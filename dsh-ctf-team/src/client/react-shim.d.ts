declare module 'react' {
  export function createElement(type: any, props: any, ...children: any[]): any
  export function useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}

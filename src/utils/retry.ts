type Fn<Args extends any[], ReturnType> = (...args: Args) => Promise<ReturnType>
export function retry<Args extends any[], ReturnType>(
  callback: Fn<Args, ReturnType>,
  delay?: number
) {
  return function (...args: Args): Promise<ReturnType> {
    return new Promise((resolve, _) => {
      return (function retry() {
        callback(...args)
          .then(resolve)
          .catch(() => {
            setTimeout(retry, delay || 500)
          })
      })()
    })
  }
}

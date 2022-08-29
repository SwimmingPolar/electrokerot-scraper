export const useCleanup = (cb: () => unknown) => {
  const cleanup = (exitCode: number) => {
    ;(async () => {
      await cb()
    })()
    process.exit(exitCode)
  }
  process.on('SIGINT', cleanup)
  process.on('exit', cleanup)
  process.on('uncaughtException', cleanup)
}

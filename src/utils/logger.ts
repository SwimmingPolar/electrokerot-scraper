import { greenBright, yellowBright, cyanBright, redBright } from 'chalk'

/**
 * @method info
 * @method error
 */
const log = {
  /**
   *
   * log successful message to console
   * @param info Message to show
   */
  info(info: string): void {
    console.log(
      new Date().toISOString() +
        ' ' +
        `[${greenBright('INFO')}] ` +
        cyanBright(info)
    )
  },
  /**
   * log critical error to console and exit process
   * @param invoker Prefix to log file
   * @param error Error message
   */
  error(invoker: string, error: string): void {
    console.log(
      new Date().toISOString() +
        ' ' +
        `[${yellowBright('ERROR')}] ${yellowBright(invoker)}` +
        ': ' +
        redBright(error)
    )
  }
}
export default log

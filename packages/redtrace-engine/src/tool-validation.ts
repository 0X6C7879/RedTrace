import { Check, Errors } from 'typebox/value'
import { actionParameters } from '../../redtrace-dsh/src/tool-domains.ts'
import { HttpError } from './types.ts'

/** Keep the full action contract, but report only errors for the action actually requested. */
export function validateToolArguments(name: string, schema: any, args: any): void {
  const parameters = actionParameters(schema, args)
  if (Check(parameters, args)) return
  const errors = [...Errors(parameters, args)].map(error => ({ path: error.instancePath, message: error.message }))
  throw new HttpError(422, 'Invalid tool arguments for ' + name + (schema.properties?.action && typeof args?.action === 'string' ? '.' + args.action : '') + '; required: ' + (parameters.required ?? []).join(',') + '; allowed: ' + Object.keys(parameters.properties ?? {}).join(',') + '; ' + JSON.stringify(errors))
}

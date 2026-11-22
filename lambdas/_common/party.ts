/** The `{partyId}` path parameter of the player endpoints. */
import { requiredString } from './validate';
import { ValidationError } from './errors';

export function partyIdParam(path: Record<string, unknown> | undefined): string {
  const id = requiredString(path, 'partyId', 64);
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new ValidationError('Validation failed', "'partyId' is not a party id");
  return id;
}

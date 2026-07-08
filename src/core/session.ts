import { v4 as uuidv4 } from 'uuid';

/**
 * Generate a new unique session ID for an agent session.
 */
export function generateSessionId(): string {
  return uuidv4();
}
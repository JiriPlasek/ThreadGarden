import type { HandleClientError } from '@sveltejs/kit/hooks';
import { describeError } from '#lib/ui-errors.js';
import { reportUiError } from '#lib/ui-error-reporter.js';

/** Errors SvelteKit catches (navigation, loading the page): to the service log, then the error page. */
export const handleError: HandleClientError = ({ error }) => {
  reportUiError('navigation', error);
  return { message: describeError(error).message };
};

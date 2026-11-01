import { client } from '#lib/state/scope.js';
import { makeReporter } from '#lib/ui-errors.js';

/** The app's reporter: the window's errors go to the local service's log. */
export const reportUiError = makeReporter((method, params) => client.request(method, params));

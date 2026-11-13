import {cookies} from 'next/headers';

import {createAuthProvider} from './provider';

export async function createServerAuthProvider() {
  const store = await cookies();
  return createAuthProvider({
    cookies: {
      getAll: () => store.getAll().map(({name, value}) => ({name, value})),
      setAll(values) {
        for (const {name, value, options} of values) store.set(name, value, options);
      },
    },
  });
}

/**
 * Persisting the acting principal (req.user / @CurrentUser()) would write the
 * chosen building's role and tenant into gate_users. ActingUserWriteGuardSubscriber
 * refuses it at runtime; these selectors flag the obvious shapes at lint time:
 * a repository / EntityManager save/update/merge/... called with `currentUser`,
 * `actingUser`, `req.user`, a spread of one of them, or the parameter bound by a
 * bare @CurrentUser() named `user` inside the same method.
 *
 * Only TypeORM-looking receivers count (`*Repository`, `*Repo`, `manager`, `m`,
 * `em`, `entityManager`, `queryRunner.manager`, ...), so passing the acting user
 * to a service method that happens to be called update() or remove() is fine.
 */
const PERSIST_METHODS = '/^(save|insert|update|upsert|merge|preload|remove|softRemove)$/';
const ORM_RECEIVER =
  ':matches(' +
  '[callee.object.name=/^(m|em|tx|manager|entityManager|transactionalEntityManager|[A-Za-z]*[Rr]epo(sitory)?)$/], ' +
  '[callee.object.property.name=/([Rr]epo(sitory)?|[Mm]anager)$/])';
const ACTING_NAMES = '/^(currentUser|actingUser)$/';
const PERSIST_CALL =
  `CallExpression[callee.type='MemberExpression'][callee.property.name=${PERSIST_METHODS}]` +
  ORM_RECEIVER;
const ACTING_USER_WRITE_MESSAGE =
  'Do not persist the acting user (req.user / @CurrentUser()): it carries the active ' +
  "membership's role and building. Load the person from a repository and save that.";

module.exports = {
  parser: '@typescript-eslint/parser',
  parserOptions: {
    // test/tsconfig.json covers test/, which the build config excludes.
    project: ['tsconfig.json', 'test/tsconfig.json'],
    tsconfigRootDir: __dirname,
    sourceType: 'module',
  },
  plugins: ['@typescript-eslint/eslint-plugin'],
  extends: [
    'plugin:@typescript-eslint/recommended',
    'plugin:prettier/recommended',
  ],
  root: true,
  env: {
    node: true,
    jest: true,
  },
  ignorePatterns: ['.eslintrc.js', 'jest.config.js', 'dist'],
  rules: {
    '@typescript-eslint/interface-name-prefix': 'off',
    '@typescript-eslint/explicit-function-return-type': 'off',
    '@typescript-eslint/explicit-module-boundary-types': 'off',
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-restricted-syntax': [
      'error',
      {
        selector: `${PERSIST_CALL} > Identifier.arguments[name=${ACTING_NAMES}]`,
        message: ACTING_USER_WRITE_MESSAGE,
      },
      {
        selector: `${PERSIST_CALL} > MemberExpression.arguments[object.name=/^(req|request)$/][property.name='user']`,
        message: ACTING_USER_WRITE_MESSAGE,
      },
      {
        selector: `${PERSIST_CALL} > ObjectExpression.arguments > SpreadElement[argument.name=${ACTING_NAMES}]`,
        message: ACTING_USER_WRITE_MESSAGE,
      },
      {
        selector:
          `MethodDefinition:has(Identifier[name='user'] > Decorator > CallExpression[callee.name='CurrentUser'][arguments.length=0]) ` +
          `${PERSIST_CALL} > Identifier.arguments[name='user']`,
        message: ACTING_USER_WRITE_MESSAGE,
      },
    ],
  },
};

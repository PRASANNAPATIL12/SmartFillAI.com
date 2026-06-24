/** @type {import('jest').Config} */
export default {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@shared/(.*)$': '<rootDir>/../shared/$1',
    '\\.css$': 'identity-obj-proxy',
    // Swap env.ts → env.mock.ts so Jest never hits import.meta
    // Matches both './env' (relative) and '@/ai-providers/env' (alias)
    '(^\\./env$|ai-providers[/\\\\]env$)': '<rootDir>/src/ai-providers/env.mock.ts',
  },
  setupFilesAfterEnv: ['<rootDir>/src/__tests__/setup.ts'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: {
          module: 'CommonJS',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          strict: false,
        },
      },
    ],
  },
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/**/__tests__/**',
    '!src/**/*.mock.ts',
  ],
};

import { defineConfig } from '@playwright/test'
import base from './playwright.config'

// Keep long GPU measurements isolated from concurrent UI/solver checks.
export default defineConfig({
  ...base,
  testMatch: '**/*.study.ts',
  fullyParallel: false,
  workers: 1,
})

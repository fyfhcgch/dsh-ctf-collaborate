import { buildPwnPrompt, PWN_META } from './pwn.js'
import { buildReversePrompt, REVERSE_META } from './reverse.js'

export type ExpertType = 'general' | 'pwn' | 'reverse'

export const EXPERT_META = {
  general: { id: 'general', label: 'General Agent', description: 'A task without a specialist prompt' },
  pwn: PWN_META,
  reverse: REVERSE_META,
} as const

export function normalizeExpertType(value: unknown): ExpertType {
  return value === 'pwn' || value === 'reverse' ? value : 'general'
}

export function buildExpertPrompt(type: unknown, prompt: string): string {
  const expertType = normalizeExpertType(type)
  if (expertType === 'pwn') return buildPwnPrompt(prompt)
  if (expertType === 'reverse') return buildReversePrompt(prompt)
  return prompt
}

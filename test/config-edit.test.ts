import { describe, expect, it } from 'vitest';
import { changedConfigPaths, ConfigEditError, configuredSkills, editConfig, modelPath } from '../src/agents/config-edit.js';

const CONFIG = `# Ardent profile
execution:
  backend: llamacpp # runtime
providers:
  llamacpp:
    base_url: http://127.0.0.1:8080/v1
    api_key_env: LLAMACPP_API_KEY
    model: old-model
skills:
  enabled:
    - mapping
api:
  port: 8700
`;

describe('config edits', () => {
  it('changes only the allowlisted values and keeps comments and the rest of the document', () => {
    const next = editConfig(CONFIG, { 'providers.llamacpp.model': 'new-model', 'skills.enabled': ['mapping', 'research'], 'artifacts.max_bytes': 1024 });
    expect(next).toContain('# Ardent profile');
    expect(next).toContain('backend: llamacpp # runtime');
    expect(next).toContain('base_url: http://127.0.0.1:8080/v1');
    expect(next).toContain('model: new-model');
    expect(changedConfigPaths(CONFIG, next).sort()).toEqual(['artifacts.max_bytes', 'providers.llamacpp.model', 'skills.enabled']);
    expect(modelPath(CONFIG)).toBe('providers.llamacpp.model');
    expect(modelPath('execution:\n  backend: codex\n')).toBe('providers.codex.model');
  });

  it('refuses paths outside the allowlist and unreadable documents', () => {
    expect(() => editConfig(CONFIG, { 'api.port': 9000 } as never)).toThrow(ConfigEditError);
    expect(() => editConfig('a: [1, 2', { 'providers.llamacpp.model': 'x' })).toThrow(/not valid YAML/);
    expect(() => editConfig('- a\n- b\n', { 'providers.llamacpp.model': 'x' })).toThrow(/not a YAML mapping/);
    expect(changedConfigPaths(CONFIG, CONFIG.replace('port: 8700', 'port: 9000'))).toEqual(['api.port']);
  });

  it('reads the skills the saved configuration enables', () => {
    expect(configuredSkills(CONFIG)).toEqual(['mapping']);
    expect(configuredSkills('skills:\n  enabled: [mapping, web-research]\n')).toEqual(['mapping', 'web-research']);
    expect(configuredSkills('skills:\n  directories: [skills]\n')).toEqual([]);
    expect(configuredSkills('execution:\n  backend: llamacpp\n')).toEqual([]);
    expect(() => configuredSkills('skills:\n  enabled: mapping\n')).toThrow(ConfigEditError);
    expect(() => configuredSkills('skills:\n  enabled: [1, 2]\n')).toThrow(/not a list of names/);
  });
});

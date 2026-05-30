import { describe, it, expect } from 'vitest';
import { containsSpecProse, validateSpecLinks } from '../../src/server/nexus/code-doc-validator.js';

describe('containsSpecProse', () => {
  it('flags codeDoc that copies spec index excerpt', () => {
    const specExcerpt = 'Ownership at the boundary is defined by the caller';
    expect(containsSpecProse(`This module handles ${specExcerpt} in the runtime.`, [specExcerpt])).toBe(
      true,
    );
  });
  it('allows codeDoc that only references spec in links', () => {
    expect(containsSpecProse('Indexes symbols via tree-sitter and stores call edges.', [])).toBe(
      false,
    );
  });
});

describe('validateSpecLinks', () => {
  it('drops hrefs not in spec index', () => {
    const index = new Set(['/platform-spec/tooling/nexus/design-model']);
    expect(
      validateSpecLinks(
        [
          { title: 'Nexus', href: '/platform-spec/tooling/nexus/design-model' },
          { title: 'Fake', href: '/fake' },
        ],
        index,
      ),
    ).toEqual([{ title: 'Nexus', href: '/platform-spec/tooling/nexus/design-model' }]);
  });

  it('limits spec links to three validated entries', () => {
    const index = new Set([
      '/platform-spec/a',
      '/platform-spec/b',
      '/platform-spec/c',
      '/platform-spec/d',
    ]);
    expect(
      validateSpecLinks(
        [
          { title: 'A', href: '/platform-spec/a' },
          { title: 'B', href: '/platform-spec/b' },
          { title: 'C', href: '/platform-spec/c' },
          { title: 'D', href: '/platform-spec/d' },
        ],
        index,
      ),
    ).toHaveLength(3);
  });
});

import { describe, expect, it } from 'vitest';
import { buildAtlas } from '../src/build.js';
import { describeDoctor, diagnose, hasIssues } from '../src/doctor.js';
import { project } from './helpers.js';

describe('doctor', () => {
  it('reports a clean atlas as clean', () => {
    const root = project({
      'services/quote/pom.xml': `
<project><artifactId>quote-api</artifactId><dependencies>
  <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
</dependencies></project>`,
      'services/quote/.env': 'DATABASE_URL=postgres://quote-db:5432/quotes\n',
    });
    const { atlas } = buildAtlas(root);
    const report = diagnose(atlas);
    expect(hasIssues(report)).toBe(false);
    expect(describeDoctor(report)).toContain('No issues found');
  });

  it('flags an inferred store, a disconnected service, and an undescribed external', () => {
    const root = project({
      'go.mod': 'module github.com/contoso/rating-engine\n\nrequire github.com/redis/go-redis/v9 v9.3.0\n',
      'main.go': 'package main\n\nfunc main() {}\n',
      'agentatlas.yaml': 'version: 1\nsystem: { name: t }\nedges:\n  - { from: rating-engine, to: legacy-billing }\n',
    });
    const { atlas } = buildAtlas(root);
    const report = diagnose(atlas);

    expect(report.inferredStores.map((n) => n.id)).toEqual(['rating-engine-redis']);
    expect(report.undescribedExternals.map((n) => n.id)).toEqual(['legacy-billing']);
    // rating-engine has an edge (to legacy-billing), so it is not disconnected; the store is.
    expect(report.disconnected.map((n) => n.id)).not.toContain('rating-engine');

    const text = describeDoctor(report);
    expect(text).toContain('rating-engine-redis');
    expect(text).toContain('aliases: { rating-engine-redis:');
    expect(text).toContain('legacy-billing');
    expect(text).toContain('TODO: describe legacy-billing');
  });

  it('flags a compute node with no edges at all', () => {
    const root = project({
      'services/orphan/pyproject.toml': '[project]\nname = "orphan-api"\ndependencies = ["flask"]\n',
    });
    const { atlas } = buildAtlas(root);
    const report = diagnose(atlas);
    expect(report.disconnected.map((n) => n.id)).toEqual(['orphan-api']);
    expect(describeDoctor(report)).toContain('scanner blind spot');
  });
});

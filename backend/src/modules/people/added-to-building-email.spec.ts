import { ConfigService } from '@nestjs/config';
import { UserRole } from '@database/entities/user.entity';
import { EmailOptions, EmailService, escapeHtml, formatRole } from '../notification/email.service';

/**
 * The 'added to building' email (PPL-2), with the transport mocked out: only
 * the message handed to sendEmail is inspected, nothing is sent.
 */
describe('EmailService.sendAddedToBuildingEmail', () => {
  let service: EmailService;
  let sendEmail: jest.SpyInstance<Promise<boolean>, [EmailOptions]>;

  beforeEach(() => {
    const config = {
      get: (_key: string, fallback?: unknown) => fallback,
    } as unknown as ConfigService;
    service = new EmailService(config);
    sendEmail = jest.spyOn(service, 'sendEmail').mockResolvedValue(true);
  });

  const lastMessage = (): EmailOptions => sendEmail.mock.calls[sendEmail.mock.calls.length - 1][0];

  it('names the building and the role in the subject and body, and carries no credentials', async () => {
    await expect(
      service.sendAddedToBuildingEmail(
        'pat@example.test',
        'Pat Person',
        UserRole.BUILDING_ADMIN,
        'Tower C',
        'Ada Admin',
        'https://yaad.global/login',
      ),
    ).resolves.toBe(true);

    const message = lastMessage();
    expect(message.to).toBe('pat@example.test');
    expect(message.subject).toBe('You now have access to Tower C as Building Admin - Yaad');
    expect(message.html).toContain('Tower C');
    expect(message.html).toContain('Building Admin');
    expect(message.html).toContain('Ada Admin');
    expect(message.html).toContain('https://yaad.global/login');
    expect(message.html).not.toMatch(/temporary password|credential-item|Login Credentials/i);
    expect(message.html).toContain('Your password has not changed');
  });

  it('escapes names and the building, and folds line breaks out of the subject', async () => {
    await service.sendAddedToBuildingEmail(
      'x@example.test',
      '<script>alert(1)</script>',
      UserRole.SECURITY,
      'Tower "A" & <b>Co</b>\r\nBcc: evil@example.test',
      '<img src=x onerror=alert(2)>',
      'https://yaad.global/login?a="b"',
    );

    const message = lastMessage();
    expect(message.html).not.toContain('<script>');
    expect(message.html).not.toContain('<img');
    expect(message.html).not.toContain('<b>Co</b>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).toContain('Tower &quot;A&quot; &amp; &lt;b&gt;Co&lt;/b&gt;');
    expect(message.html).toContain('href="https://yaad.global/login?a=&quot;b&quot;"');
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.subject).toContain('as Security');
  });

  it('falls back to "An administrator" and the address when names are missing', async () => {
    await service.sendAddedToBuildingEmail(
      'x@example.test',
      '  ',
      UserRole.RESIDENT,
      'B',
      null,
      'u',
    );

    const message = lastMessage();
    expect(message.html).toContain('An administrator has added you');
    expect(message.html).toContain('Hello <strong>x@example.test</strong>');
    expect(message.subject).toContain('as Resident');
  });

  it('the credentials email still names the role the same way', async () => {
    await service.sendNewUserCredentialsEmail(
      'n@example.test',
      'New Person',
      UserRole.BUILDING_ADMIN,
      'Temp#1',
      'Tower A',
      'Ada',
      'u',
    );
    expect(lastMessage().html).toContain('Building Admin');
  });

  it('formatRole and escapeHtml', () => {
    expect(formatRole('building_admin')).toBe('Building Admin');
    expect(formatRole('SECURITY')).toBe('Security');
    expect(escapeHtml(`<a href='x'>&"`)).toBe('&lt;a href=&#39;x&#39;&gt;&amp;&quot;');
    expect(escapeHtml(null)).toBe('');
  });
});

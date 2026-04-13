import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';
import { Transporter } from 'nodemailer';

export interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private transporter: Transporter;

  constructor(private readonly configService: ConfigService) {
    this.initializeTransporter();
  }

  private initializeTransporter() {
    const host = this.configService.get<string>('SMTP_HOST', 'localhost');
    const port = this.configService.get<number>('SMTP_PORT', 1025);
    const user = this.configService.get<string>('SMTP_USER', '');
    const pass = this.configService.get<string>('SMTP_PASS', '');

    // Auto-detect secure mode based on port
    // Port 465: Use SSL/TLS from the start (secure: true)
    // Port 587 or others: Use STARTTLS (secure: false, but with requireTLS)
    const secure = port === 465;
    const useTLS = port === 587 || (user && pass); // Use TLS for port 587 or when auth is provided

    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure, // true only for port 465
      requireTLS: useTLS, // Require TLS upgrade for port 587
      tls: {
        rejectUnauthorized: false, // Accept self-signed certs in development
        ciphers: 'SSLv3',
        minVersion: 'TLSv1.2',
      },
      // Only include auth if credentials are provided
      ...(user && pass ? { auth: { user, pass } } : {}),
      debug: this.configService.get<string>('NODE_ENV') !== 'production', // Enable debug in dev
      logger: this.configService.get<string>('NODE_ENV') !== 'production', // Enable logging in dev
    } as nodemailer.TransportOptions);

    this.logger.log(
      `Email transporter initialized: ${host}:${port} (secure: ${secure}, requireTLS: ${useTLS})`,
    );
  }

  async sendEmail(options: EmailOptions): Promise<boolean> {
    const from = this.configService.get<string>('SMTP_FROM', 'GateRecord <noreply@gaterecord.com>');
    const domain = this.configService.get<string>('APP_DOMAIN', 'gaterecord.com');

    try {
      const result = await this.transporter.sendMail({
        from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text || this.stripHtml(options.html),
        headers: {
          'X-Priority': '1',
          'X-Mailer': 'GateRecord Notification Service',
          'List-Unsubscribe': `<mailto:unsubscribe@${domain}>`,
          'Precedence': 'bulk',
        },
      });

      this.logger.log(`Email sent successfully to ${options.to}: ${result.messageId}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to send email to ${options.to}:`, error);
      return false;
    }
  }

  async sendVisitorPassEmail(
    visitorEmail: string,
    visitorName: string,
    hostName: string,
    buildingName: string,
    passUrl: string,
    validFrom: Date,
    validUntil: Date,
  ): Promise<boolean> {
    const formatDate = (date: Date) => {
      return new Date(date).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      });
    };

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #1890ff; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
          .button { display: inline-block; background: #52c41a; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: bold; }
          .info-box { background: white; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #1890ff; }
          .footer { text-align: center; color: #888; font-size: 12px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Visitor Pass</h1>
            <p>Your access pass for ${buildingName}</p>
          </div>
          <div class="content">
            <p>Hello <strong>${visitorName}</strong>,</p>
            <p>You have been invited to visit <strong>${buildingName}</strong> by <strong>${hostName}</strong>.</p>

            <div class="info-box">
              <p><strong>Valid Period:</strong></p>
              <p>From: ${formatDate(validFrom)}</p>
              <p>Until: ${formatDate(validUntil)}</p>
            </div>

            <p>Click the button below to view your QR code pass:</p>

            <div style="text-align: center;">
              <a href="${passUrl}" class="button">View Your Pass</a>
            </div>

            <p>When you arrive, simply show the QR code at the gate scanner for entry.</p>

            <div class="info-box">
              <p><strong>Tips:</strong></p>
              <ul>
                <li>Save this email or bookmark the pass link</li>
                <li>Make sure your phone brightness is high when scanning</li>
                <li>The pass is only valid during the specified time period</li>
              </ul>
            </div>
          </div>
          <div class="footer">
            <p>This is an automated message from GateRecord.</p>
            <p>If you didn't expect this email, please ignore it.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({
      to: visitorEmail,
      subject: `Your Visitor Pass for ${buildingName}`,
      html,
    });
  }

  private stripHtml(html: string): string {
    return html
      .replace(/<[^>]*>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  async sendVisitorEntryNotification(
    residentEmail: string,
    residentName: string,
    visitorName: string,
    buildingName: string,
    gateName: string,
    entryTime: Date,
    accessEventId: string,
    reportUnauthorizedUrl: string,
  ): Promise<boolean> {
    const formatTime = (date: Date) => {
      return new Date(date).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
    };

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #52c41a; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
          .info-box { background: white; padding: 15px; border-radius: 5px; margin: 15px 0; border-left: 4px solid #52c41a; }
          .warning-box { background: #fff2f0; padding: 20px; border-radius: 5px; margin: 20px 0; border: 1px solid #ffccc7; text-align: center; }
          .danger-button { display: inline-block; background: #ff4d4f; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; }
          .footer { text-align: center; color: #888; font-size: 12px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Visitor Entry Alert</h1>
            <p>Your visitor has entered ${buildingName}</p>
          </div>
          <div class="content">
            <p>Hello <strong>${residentName}</strong>,</p>
            <p>This is to notify you that your visitor has just entered the building.</p>

            <div class="info-box">
              <p><strong>Entry Details:</strong></p>
              <p><strong>Visitor:</strong> ${visitorName}</p>
              <p><strong>Gate:</strong> ${gateName}</p>
              <p><strong>Time:</strong> ${formatTime(entryTime)}</p>
            </div>

            <div class="warning-box">
              <p><strong>Is this visitor NOT authorized?</strong></p>
              <p style="color: #666; font-size: 14px;">If you did not authorize this visitor or don't recognize them, click the button below immediately. Security will be alerted.</p>
              <br>
              <a href="${reportUnauthorizedUrl}" class="danger-button">
                REPORT UNAUTHORIZED ENTRY
              </a>
            </div>

            <p style="color: #888; font-size: 12px;">If this visitor is expected, no action is needed. This email is for your awareness only.</p>
          </div>
          <div class="footer">
            <p>This is an automated security notification from GateRecord.</p>
            <p>Event ID: ${accessEventId}</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({
      to: residentEmail,
      subject: `[VISITOR ENTRY] ${visitorName} has entered ${buildingName}`,
      html,
    });
  }

  async sendSecurityAlertEmail(
    securityEmail: string,
    visitorName: string,
    residentName: string,
    buildingName: string,
    gateName: string,
    entryTime: Date,
    reportedBy: string,
    accessEventId: string,
  ): Promise<boolean> {
    const formatTime = (date: Date) => {
      return new Date(date).toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        second: '2-digit',
        hour12: true,
      });
    };

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: #ff4d4f; color: white; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
          .content { background: #fff2f0; padding: 30px; border-radius: 0 0 8px 8px; }
          .alert-box { background: white; padding: 20px; border-radius: 5px; margin: 15px 0; border: 2px solid #ff4d4f; }
          .footer { text-align: center; color: #888; font-size: 12px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>SECURITY ALERT</h1>
            <p>UNAUTHORIZED VISITOR REPORTED</p>
          </div>
          <div class="content">
            <div class="alert-box">
              <h2 style="color: #ff4d4f; margin-top: 0;">IMMEDIATE ACTION REQUIRED</h2>
              <p><strong>Visitor:</strong> ${visitorName}</p>
              <p><strong>Gate:</strong> ${gateName}</p>
              <p><strong>Entry Time:</strong> ${formatTime(entryTime)}</p>
              <p><strong>Reported By:</strong> ${reportedBy}</p>
              <p><strong>Resident:</strong> ${residentName}</p>
              <hr>
              <p style="color: #ff4d4f;"><strong>The resident has reported this visitor as UNAUTHORIZED.</strong></p>
              <p>Please investigate immediately and take appropriate action.</p>
            </div>
          </div>
          <div class="footer">
            <p>GateRecord Security System</p>
            <p>Event ID: ${accessEventId}</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({
      to: securityEmail,
      subject: `[SECURITY ALERT] Unauthorized Visitor: ${visitorName} at ${gateName}`,
      html,
    });
  }

  async verifyConnection(): Promise<boolean> {
    try {
      await this.transporter.verify();
      this.logger.log('Email server connection verified');
      return true;
    } catch (error) {
      this.logger.error('Email server connection failed:', error);
      return false;
    }
  }

  async sendWelcomeEmail(
    userEmail: string,
    userName: string,
    buildingName: string,
    loginUrl: string,
  ): Promise<boolean> {
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #1890ff 0%, #096dd9 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .header h1 { margin: 0; font-size: 28px; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
          .button { display: inline-block; background: #52c41a; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: bold; }
          .info-box { background: white; padding: 20px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #1890ff; }
          .feature-list { list-style: none; padding: 0; }
          .feature-list li { padding: 10px 0; border-bottom: 1px solid #eee; }
          .feature-list li:last-child { border-bottom: none; }
          .feature-list li::before { content: "✓"; color: #52c41a; font-weight: bold; margin-right: 10px; }
          .footer { text-align: center; color: #888; font-size: 12px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome to GateRecord!</h1>
            <p>Your account has been successfully created</p>
          </div>
          <div class="content">
            <p>Hello <strong>${userName}</strong>,</p>
            <p>Welcome to GateRecord! Your building <strong>${buildingName}</strong> is now set up and ready to use.</p>

            <div class="info-box">
              <p><strong>What's Next?</strong></p>
              <ul class="feature-list">
                <li>Add your gates and configure access points</li>
                <li>Register residents and their RFID cards</li>
                <li>Set up visitor management</li>
                <li>Monitor access events in real-time</li>
              </ul>
            </div>

            <div style="text-align: center;">
              <a href="${loginUrl}" class="button">Go to Dashboard</a>
            </div>

            <div class="info-box">
              <p><strong>Need Help?</strong></p>
              <p>If you have any questions or need assistance getting started, please don't hesitate to contact our support team.</p>
            </div>
          </div>
          <div class="footer">
            <p>This is an automated message from GateRecord.</p>
            <p>© ${new Date().getFullYear()} GateRecord. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({
      to: userEmail,
      subject: `Welcome to GateRecord - ${buildingName}`,
      html,
    });
  }

  /**
   * Send credentials email to newly created user
   */
  async sendNewUserCredentialsEmail(
    userEmail: string,
    userName: string,
    role: string,
    temporaryPassword: string,
    buildingName: string,
    createdByName: string,
    loginUrl: string,
  ): Promise<boolean> {
    const roleDisplayName = role
      .split('_')
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ');

    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #722ed1 0%, #531dab 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .header h1 { margin: 0; font-size: 28px; }
          .content { background: #f9f9f9; padding: 30px; border-radius: 0 0 8px 8px; }
          .button { display: inline-block; background: #722ed1; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; margin: 20px 0; font-weight: bold; }
          .credentials-box { background: white; padding: 20px; border-radius: 5px; margin: 20px 0; border: 2px solid #722ed1; }
          .credentials-box h3 { margin-top: 0; color: #722ed1; }
          .credential-item { background: #f5f5f5; padding: 12px 15px; margin: 10px 0; border-radius: 4px; font-family: monospace; font-size: 14px; word-break: break-all; }
          .warning-box { background: #fff7e6; padding: 20px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #fa8c16; }
          .warning-box h4 { color: #fa8c16; margin-top: 0; }
          .role-badge { display: inline-block; background: #722ed1; color: white; padding: 5px 15px; border-radius: 20px; font-size: 14px; }
          .footer { text-align: center; color: #888; font-size: 12px; margin-top: 20px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Welcome to GateRecord!</h1>
            <p>Your account has been created</p>
          </div>
          <div class="content">
            <p>Hello <strong>${userName}</strong>,</p>
            <p>An account has been created for you by <strong>${createdByName}</strong> at <strong>${buildingName}</strong>.</p>

            <p>Your assigned role: <span class="role-badge">${roleDisplayName}</span></p>

            <div class="credentials-box">
              <h3>🔐 Your Login Credentials</h3>
              <p><strong>Email:</strong></p>
              <div class="credential-item">${userEmail}</div>
              <p><strong>Temporary Password:</strong></p>
              <div class="credential-item">${temporaryPassword}</div>
            </div>

            <div class="warning-box">
              <h4>⚠️ Important Security Notice</h4>
              <p>For your security, please <strong>change your password immediately</strong> after your first login.</p>
              <p>To change your password:</p>
              <ol>
                <li>Log in with the credentials above</li>
                <li>Go to <strong>Settings → Security</strong></li>
                <li>Click <strong>Change Password</strong></li>
                <li>Create a strong, unique password</li>
              </ol>
            </div>

            <div style="text-align: center;">
              <a href="${loginUrl}" class="button">Login to GateRecord</a>
            </div>

            <p style="color: #888; font-size: 13px;">
              <strong>Password Tips:</strong> Use at least 8 characters with uppercase, lowercase, numbers, and special characters.
            </p>
          </div>
          <div class="footer">
            <p>This is an automated message from GateRecord.</p>
            <p>If you did not expect this email, please contact your administrator.</p>
            <p>© ${new Date().getFullYear()} GateRecord. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({
      to: userEmail,
      subject: `Your GateRecord Account - ${buildingName}`,
      html,
    });
  }

  async sendPasswordResetOtp(
    userEmail: string,
    userName: string,
    otp: string,
    expiresInSeconds: number = 60,
  ): Promise<boolean> {
    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <meta http-equiv="X-UA-Compatible" content="IE=edge">
        <title>Password Reset - GateRecord</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; background-color: #f5f5f5; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #5EBAB4 0%, #4AA8A2 100%); color: white; padding: 30px; text-align: center; border-radius: 8px 8px 0 0; }
          .header h1 { margin: 0; font-size: 28px; font-weight: 600; }
          .header p { margin: 10px 0 0; opacity: 0.9; }
          .content { background: #ffffff; padding: 30px; border-radius: 0 0 8px 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1); }
          .otp-box { background: #f0faf9; padding: 30px; border-radius: 8px; margin: 25px 0; text-align: center; border: 2px solid #5EBAB4; }
          .otp-code { font-size: 36px; font-weight: bold; letter-spacing: 10px; color: #5EBAB4; margin: 0; font-family: 'Courier New', monospace; }
          .info-box { background: #f0faf9; padding: 15px 20px; border-radius: 5px; margin: 20px 0; border-left: 4px solid #5EBAB4; }
          .info-box p { margin: 5px 0; }
          .warning { color: #666; font-size: 14px; margin-top: 20px; padding: 15px; background: #fafafa; border-radius: 5px; }
          .footer { text-align: center; color: #888; font-size: 12px; margin-top: 25px; padding-top: 20px; border-top: 1px solid #eee; }
          .footer p { margin: 5px 0; }
          .logo { font-size: 24px; font-weight: bold; margin-bottom: 10px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="logo">GateRecord</div>
            <h1>Password Reset</h1>
            <p>Your verification code</p>
          </div>
          <div class="content">
            <p>Hello <strong>${userName}</strong>,</p>
            <p>We received a request to reset your password for your GateRecord account. Use the verification code below to proceed:</p>

            <div class="otp-box">
              <p style="margin: 0 0 10px; color: #666; font-size: 14px;">Your verification code</p>
              <p class="otp-code">${otp}</p>
            </div>

            <div class="info-box">
              <p><strong>⏱️ This code will expire in ${expiresInSeconds} seconds.</strong></p>
              <p>Enter this code on the password reset page to verify your identity.</p>
            </div>

            <div class="warning">
              <p><strong>🔒 Security Notice:</strong> If you didn't request a password reset, please ignore this email. Your account is safe and no action is required.</p>
            </div>
          </div>
          <div class="footer">
            <p>This is an automated message from GateRecord.</p>
            <p>Please do not reply to this email.</p>
            <p>© ${new Date().getFullYear()} GateRecord. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    return this.sendEmail({
      to: userEmail,
      subject: 'Password Reset Code - GateRecord',
      html,
    });
  }
}

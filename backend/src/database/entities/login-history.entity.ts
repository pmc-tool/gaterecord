import { Entity, Column, ManyToOne, JoinColumn, Index } from 'typeorm';
import { BaseEntity } from './base.entity';
import { User } from './user.entity';

export enum LoginStatus {
  SUCCESS = 'success',
  FAILED = 'failed',
}

@Entity('login_history')
@Index(['userId'])
@Index(['createdAt'])
export class LoginHistory extends BaseEntity {
  @Column({ name: 'user_id' })
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: LoginStatus, default: LoginStatus.SUCCESS })
  status: LoginStatus;

  @Column({ name: 'ip_address', nullable: true })
  ipAddress: string;

  @Column({ name: 'user_agent', nullable: true })
  userAgent: string;

  @Column({ nullable: true })
  browser: string;

  @Column({ nullable: true })
  os: string;

  @Column({ nullable: true })
  device: string;

  @Column({ nullable: true })
  location: string;

  @Column({ name: 'failure_reason', nullable: true })
  failureReason: string;
}

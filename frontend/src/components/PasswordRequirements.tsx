import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { Typography } from 'antd';

const { Text } = Typography;

interface PasswordRequirementsProps {
  password: string;
}

interface Requirement {
  label: string;
  test: (password: string) => boolean;
}

const requirements: Requirement[] = [
  { label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { label: 'One uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { label: 'One lowercase letter', test: (p) => /[a-z]/.test(p) },
  { label: 'One number', test: (p) => /[0-9]/.test(p) },
  { label: 'One special character (@$!%*?&)', test: (p) => /[@$!%*?&]/.test(p) },
];

export function validatePassword(password: string): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!password) {
    return { isValid: false, errors: ['Please enter your password'] };
  }
  
  requirements.forEach((req) => {
    if (!req.test(password)) {
      errors.push(req.label);
    }
  });
  
  return { isValid: errors.length === 0, errors };
}

export default function PasswordRequirements({ password }: PasswordRequirementsProps) {
  return (
    <div className="p-4 bg-blue-50 border border-blue-100 rounded-lg mb-4">
      <div className="flex items-center gap-2 mb-3">
        <CheckCircleOutlined className="text-blue-500" />
        <Text strong className="text-gray-700">Password Requirements</Text>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        {requirements.map((req, index) => {
          const isMet = password ? req.test(password) : false;
          return (
            <div key={index} className="flex items-center gap-2">
              {isMet ? (
                <CheckCircleOutlined className="text-green-500 text-sm flex-shrink-0" />
              ) : (
                <CloseCircleOutlined className="text-gray-300 text-sm flex-shrink-0" />
              )}
              <Text 
                className={`text-sm ${isMet ? 'text-green-600' : 'text-gray-500'}`}
              >
                {req.label}
              </Text>
            </div>
          );
        })}
      </div>
    </div>
  );
}

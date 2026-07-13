export type AdminFallbackSeed = {
  openId: string;
  name: string;
  email: string;
  employeeId: string;
  password: string;
  department: string;
  position: string;
};

export type EmployeeSeed = {
  openId: string;
  name: string;
  email: string;
  employeeId: string;
  password: string;
  department: string;
  position: string;
  cnic?: string;
  mobilePhone?: string;
};

export const adminFallbackSeed: AdminFallbackSeed = {
  openId: "admin-aamir-001",
  name: "Aamir",
  email: "aamir@rad.com",
  employeeId: "ADMIN001",
  password: "Admin@123",
  department: "Management",
  position: "Founder & COO",
};

export const employeeSeeds: EmployeeSeed[] = [
  {
    openId: "emp-talha-aziz",
    name: "Talha Aziz",
    email: "talha.aziz@wehearyou.studio",
    employeeId: "Talha Aziz",
    password: "Talha@7576",
    department: "Design",
    position: "Graphic Designer",
    cnic: "42201-7475275-3",
    mobilePhone: "0317-8927576",
  },
  {
    openId: "emp-eshal-khurshid",
    name: "Eshal Khurshid",
    email: "eshal.khurshid@wehearyou.studio",
    employeeId: "Eshal Khurshid",
    password: "Eshal@9998",
    department: "Finance",
    position: "Account Manager",
    cnic: "42301-6480817-2",
    mobilePhone: "0301-8929998",
  },
  {
    openId: "emp-fabeha",
    name: "Fabeha",
    email: "fabeha@wehearyou.studio",
    employeeId: "Fabeha",
    password: "Fabeha@7500",
    department: "Design",
    position: "Brand Manager",
    cnic: "42201-8237782-0",
    mobilePhone: "0333-2617500",
  },
  {
    openId: "emp-arij-ali-khan",
    name: "Arij Ali Khan",
    email: "arij.khan@wehearyou.studio",
    employeeId: "Arij Ali Khan",
    password: "Arij@1194",
    department: "Design",
    position: "Visual Designer",
    cnic: "42101-7843658-5",
    mobilePhone: "0341-0291194",
  },
  {
    openId: "emp-muhammad-hassan",
    name: "Muhammad Hassan",
    email: "hassan@wehearyou.studio",
    employeeId: "Muhammad Hassan",
    password: "Hassan@8346",
    department: "Engineering",
    position: "Sr web Dev",
    cnic: "42101-9630488-3",
    mobilePhone: "0347-2228346",
  },
  {
    openId: "emp-arsalan-khan",
    name: "Arsalan Khan",
    email: "arsalan.khan@wehearyou.studio",
    employeeId: "Arsalan Khan",
    password: "Arsalan@4414",
    department: "Marketing",
    position: "Marketing Performance",
    cnic: "42301-9828671-5",
    mobilePhone: "0332-0044414",
  },
  {
    openId: "emp-taha-yaseen",
    name: "Taha Yaseen",
    email: "taha.yaseen@wehearyou.studio",
    employeeId: "Taha Yaseen",
    password: "Taha@0976",
    department: "Marketing",
    position: "SEO Manager",
    cnic: "42201-8844386-7",
    mobilePhone: "0326-2856976",
  },
  {
    openId: "emp-shaheryar-khan",
    name: "Shaheryar Khan",
    email: "shaheryar.khan@wehearyou.studio",
    employeeId: "Shaheryar Khan",
    password: "Shaheryar@5278",
    department: "Design",
    position: "Graphic Designer",
    cnic: "42201-1177439-9",
    mobilePhone: "0335-2615278",
  },
  {
    openId: "emp-muzamil-pervaiz",
    name: "Muzamil Pervaiz",
    email: "muzamil.pervaiz@wehearyou.studio",
    employeeId: "Muzamil Pervaiz",
    password: "Muzamil@7400",
    department: "Finance",
    position: "Finance",
    cnic: "45203-4548175-5",
    mobilePhone: "0301-3437400",
  },
  {
    openId: "emp-fayyaz",
    name: "Fayyaz",
    email: "fayyaz.hussain@wehearyou.studio",
    employeeId: "Fayyaz",
    password: "Fayyaz@9744",
    department: "Engineering",
    position: "Sr web Dev",
    mobilePhone: "0319-4089744",
  },
  {
    openId: "emp-muhammad-anas",
    name: "Muhammad Anas",
    email: "muhammad.anas@wehearyou.studio",
    employeeId: "Muhammad Anas",
    password: "Anas@5969",
    department: "Marketing",
    position: "SEO",
    cnic: "41304-3973357-5",
    mobilePhone: "0313-3165969",
  },
  {
    openId: "emp-muhammad-owais",
    name: "Muhammad Owais",
    email: "muhammad.owais@wehearyou.studio",
    employeeId: "Muhammad Owais",
    password: "Owais@6646",
    department: "Engineering",
    position: "Web Dev",
    cnic: "42101-7898319-9",
    mobilePhone: "0317-3616646",
  },
  {
    openId: "emp-tayaba-aslam",
    name: "Tayaba Aslam",
    email: "tayaba.aslam@wehearyou.studio",
    employeeId: "Tayaba Aslam",
    password: "Tayaba@HR13",
    department: "Design",
    position: "Brand Manager",
  },
  {
    openId: "emp-muhammad-ali",
    name: "Muhammad Ali",
    email: "muhammad.ali@wehearyou.studio",
    employeeId: "Muhammad Ali",
    password: "MuhammadAli@HR14",
    department: "Finance",
    position: "Account Manager",
  },
];
